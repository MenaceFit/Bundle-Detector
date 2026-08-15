"""Solscan Pro API provider — optional accelerator.

Solscan is used for holder distribution and account labels.  It requires a Pro
API key (header ``token``).  Because the Pro API's shape is versioned and
key-gated, every response is defensively normalised and any failure degrades to
the RPC path rather than aborting a scan.

Endpoints used (Solscan Pro v2):
  GET /v2.0/token/holders   ?address=&page=&page_size=
  GET /v2.0/token/meta      ?address=
  GET /v2.0/account/detail  ?address=

If Solscan changes a response shape, `docs/API_MATRIX.md` documents how to
re-verify, and the engine keeps working from RPC in the meantime.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.providers.base import (
    DataQuality,
    HolderProvider,
    ProviderError,
    ProviderStatus,
    RateLimitedError,
)
from app.utils.concurrency import CircuitBreaker, TokenBucket
from app.utils.logging import get_logger

log = get_logger("API")

BASE_URL = "https://pro-api.solscan.io/v2.0"


class SolscanProvider(HolderProvider):
    name = "solscan"

    def __init__(
        self,
        api_key: str | None,
        *,
        quality: DataQuality | None = None,
        cache: Any | None = None,
        requests_per_second: float = 5.0,
        timeout: float = 20.0,
    ) -> None:
        self.api_key = api_key
        self.quality = quality or DataQuality()
        self.cache = cache
        self.enabled = bool(api_key)
        self._bucket = TokenBucket(requests_per_second)
        self._breaker = CircuitBreaker(name=self.name)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={"token": api_key or "", "accept": "application/json"},
        )
        self.quality.health(self.name).status = (
            ProviderStatus.OK if self.enabled else ProviderStatus.DISABLED
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict[str, Any]) -> Any:
        if not self.enabled:
            raise ProviderError("solscan: not configured")
        self._breaker.check()
        await self._bucket.acquire()
        health = self.quality.health(self.name)
        start = time.monotonic()
        try:
            response = await self._client.get(f"{BASE_URL}{path}", params=params)
        except httpx.HTTPError as exc:
            self._breaker.record_failure()
            health.record(time.monotonic() - start, False, str(exc))
            raise ProviderError(f"solscan: {exc}") from exc
        elapsed = time.monotonic() - start
        if response.status_code == 429:
            self._breaker.record_failure()
            health.record(elapsed, False, "HTTP 429")
            raise RateLimitedError("solscan: rate limited")
        if response.status_code >= 400:
            self._breaker.record_failure()
            health.record(elapsed, False, f"HTTP {response.status_code}")
            raise ProviderError(f"solscan: HTTP {response.status_code}")
        self._breaker.record_success()
        health.record(elapsed, True)
        self.quality.api_requests += 1
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError("solscan: invalid JSON") from exc
        if isinstance(body, dict) and body.get("success") is False:
            raise ProviderError(f"solscan: {body.get('message', 'request rejected')}")
        return body

    @staticmethod
    def _items(body: Any) -> list[dict[str, Any]]:
        """Solscan wraps payloads inconsistently across endpoints/versions."""
        if isinstance(body, list):
            return [x for x in body if isinstance(x, dict)]
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, list):
                return [x for x in data if isinstance(x, dict)]
            if isinstance(data, dict):
                items = data.get("items")
                if isinstance(items, list):
                    return [x for x in items if isinstance(x, dict)]
                return [data]
        return []

    async def get_token_holders(self, mint: str, *, limit: int = 50) -> list[dict[str, Any]]:
        holders: list[dict[str, Any]] = []
        page = 1
        page_size = 40  # Solscan accepts a fixed set of page sizes; 40 is safe
        while len(holders) < limit and page <= 25:
            try:
                body = await self._get(
                    "/token/holders", {"address": mint, "page": page, "page_size": page_size}
                )
            except ProviderError as exc:
                log.debug("solscan holders failed", mint=mint, error=str(exc))
                break
            items = self._items(body)
            if not items:
                break
            for item in items:
                owner = item.get("owner") or item.get("address")
                amount = item.get("amount")
                if owner is None or amount is None:
                    continue
                holders.append(
                    {
                        "token_account": item.get("token_account") or item.get("address"),
                        "owner": owner,
                        "amount": int(amount),
                        "decimals": item.get("decimals"),
                        "ui_amount": item.get("ui_amount"),
                    }
                )
            if len(items) < page_size:
                break
            page += 1
        holders.sort(key=lambda h: h["amount"], reverse=True)
        return holders[:limit]

    async def get_account_detail(self, address: str) -> dict[str, Any] | None:
        """Account detail; its ``account_label`` field feeds entity classification."""
        cache_key = f"solscan:account:{address}"
        if self.cache is not None:
            cached = await self.cache.get(cache_key)
            if cached is not None:
                self.quality.cache_hits += 1
                return cached
        try:
            body = await self._get("/account/detail", {"address": address})
        except ProviderError:
            return None
        items = self._items(body)
        detail = items[0] if items else None
        if detail and self.cache is not None:
            await self.cache.set(cache_key, detail, ttl=3600)
        return detail

    async def get_token_meta(self, mint: str) -> dict[str, Any] | None:
        try:
            body = await self._get("/token/meta", {"address": mint})
        except ProviderError:
            return None
        items = self._items(body)
        return items[0] if items else None
