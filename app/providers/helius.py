"""Helius provider — optional accelerator.

Used for two things the plain RPC cannot do cheaply:

* **Full holder lists** via the DAS ``getTokenAccounts`` method (plain RPC only
  exposes the top 20 accounts through ``getTokenLargestAccounts``).
* **Asset metadata** via DAS ``getAsset`` (name / symbol / URI / socials).

Everything here is optional: with no ``HELIUS_API_KEY`` the class reports
``DISABLED`` and the engine falls back to RPC, losing coverage (which lowers
the confidence score) but never breaking.
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
    PumpFunProvider,
    RateLimitedError,
)
from app.utils.concurrency import CircuitBreaker, CircuitBreakerOpen, TokenBucket, retry_async
from app.utils.logging import get_logger

log = get_logger("API")

DAS_ENDPOINT = "https://mainnet.helius-rpc.com/"
ENHANCED_ENDPOINT = "https://api.helius.xyz/v0"


class HeliusProvider(HolderProvider, PumpFunProvider):
    name = "helius"

    def __init__(
        self,
        api_key: str | None,
        *,
        quality: DataQuality | None = None,
        cache: Any | None = None,
        requests_per_second: float = 10.0,
        timeout: float = 20.0,
    ) -> None:
        self.api_key = api_key
        self.quality = quality or DataQuality()
        self.cache = cache
        self.enabled = bool(api_key)
        self._bucket = TokenBucket(requests_per_second)
        self._breaker = CircuitBreaker(name=self.name)
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0))
        health = self.quality.health(self.name)
        health.status = ProviderStatus.DISABLED if not self.enabled else ProviderStatus.OK

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        if not self.enabled:
            raise ProviderError("helius: not configured")
        self._breaker.check()
        await self._bucket.acquire()
        health = self.quality.health(self.name)
        start = time.monotonic()
        try:
            response = await self._client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            self._breaker.record_failure()
            health.record(time.monotonic() - start, False, str(exc))
            raise ProviderError(f"helius: {exc}") from exc
        elapsed = time.monotonic() - start
        if response.status_code == 429:
            self._breaker.record_failure()
            health.record(elapsed, False, "HTTP 429")
            raise RateLimitedError("helius: rate limited")
        if response.status_code >= 400:
            self._breaker.record_failure()
            health.record(elapsed, False, f"HTTP {response.status_code}")
            raise ProviderError(f"helius: HTTP {response.status_code}")
        self._breaker.record_success()
        health.record(elapsed, True)
        self.quality.api_requests += 1
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderError("helius: invalid JSON") from exc

    async def _das(self, method: str, params: Any) -> Any:
        body = await retry_async(
            lambda: self._request(
                "POST",
                DAS_ENDPOINT,
                params={"api-key": self.api_key},
                json={"jsonrpc": "2.0", "id": "pfbd", "method": method, "params": params},
            ),
            attempts=3,
            retry_on=(ProviderError,),
            give_up_on=(CircuitBreakerOpen,),
            label=method,
        )
        if isinstance(body, dict) and body.get("error"):
            raise ProviderError(f"helius {method}: {body['error']}")
        return (body or {}).get("result")

    # ------------------------------------------------------------------
    async def get_token_holders(self, mint: str, *, limit: int = 50) -> list[dict[str, Any]]:
        """Complete holder list via DAS ``getTokenAccounts`` (paginated)."""
        holders: list[dict[str, Any]] = []
        page = 1
        while len(holders) < limit and page <= 20:
            result = await self._das(
                "getTokenAccounts",
                {"mint": mint, "page": page, "limit": min(1000, max(limit, 100))},
            )
            accounts = (result or {}).get("token_accounts") or []
            if not accounts:
                break
            for account in accounts:
                amount = int(account.get("amount") or 0)
                if amount <= 0:
                    continue
                holders.append(
                    {
                        "token_account": account.get("address"),
                        "owner": account.get("owner"),
                        "amount": amount,
                        "decimals": None,
                        "ui_amount": None,
                    }
                )
            if len(accounts) < 1000:
                break
            page += 1
        holders.sort(key=lambda h: h["amount"], reverse=True)
        return holders[:limit]

    async def get_token_metadata(self, mint: str) -> dict[str, Any] | None:
        """DAS ``getAsset``: name, symbol, off-chain JSON URI and its contents."""
        cache_key = f"helius:asset:{mint}"
        if self.cache is not None:
            cached = await self.cache.get(cache_key)
            if cached is not None:
                self.quality.cache_hits += 1
                return cached
        try:
            asset = await self._das("getAsset", {"id": mint})
        except ProviderError as exc:
            log.debug("helius getAsset failed", mint=mint, error=str(exc))
            return None
        if not asset:
            return None
        content = asset.get("content") or {}
        metadata = content.get("metadata") or {}
        links = content.get("links") or {}
        parsed = {
            "name": metadata.get("name"),
            "symbol": metadata.get("symbol"),
            "description": metadata.get("description"),
            "uri": (content.get("json_uri") or None),
            "image": links.get("image"),
            "external_url": links.get("external_url"),
            "socials": {k: v for k, v in links.items() if k not in {"image", "external_url"}},
            "supply": (asset.get("token_info") or {}).get("supply"),
            "decimals": (asset.get("token_info") or {}).get("decimals"),
            "source": "helius-das",
        }
        if self.cache is not None:
            await self.cache.set(cache_key, parsed, ttl=3600)
        return parsed

    async def get_enhanced_transactions(self, signatures: list[str]) -> list[dict[str, Any]]:
        """Helius Enhanced Transactions API — human-readable transfer parsing.

        Used only as a cross-check on the funding tracer; the tracer's own
        conclusions come from raw balance deltas so they stay valid without it.
        """
        if not signatures:
            return []
        out: list[dict[str, Any]] = []
        for start in range(0, len(signatures), 100):  # documented API limit
            chunk = signatures[start : start + 100]
            try:
                body = await self._request(
                    "POST",
                    f"{ENHANCED_ENDPOINT}/transactions",
                    params={"api-key": self.api_key},
                    json={"transactions": chunk},
                )
            except ProviderError as exc:
                log.debug("helius enhanced tx failed", error=str(exc))
                break
            if isinstance(body, list):
                out.extend(body)
        return out
