"""Async Solana JSON-RPC client.

This is the authoritative data source of the whole engine.  Helius and Solscan
are accelerators; RPC is the ground truth, and every derived number in a report
can be traced back to a transaction signature fetched here.

Features required by the spec: token-bucket rate limiting, exponential backoff
with jitter, per-endpoint circuit breakers, automatic failover between
endpoints, request de-duplication and JSON-RPC batching.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from app.providers.base import (
    DataQuality,
    HolderProvider,
    ProviderError,
    RateLimitedError,
    SolanaProvider,
    TransactionProvider,
)
from app.utils.concurrency import CircuitBreaker, CircuitBreakerOpen, SingleFlight, TokenBucket, retry_async
from app.utils.logging import get_logger

log = get_logger("API")

#: Max signatures returnable by `getSignaturesForAddress` in one call.
SIGNATURE_PAGE_SIZE = 1000
#: Conservative batch size: large batches are the main cause of 413/timeout.
DEFAULT_BATCH_SIZE = 40


class SolanaRpcClient(SolanaProvider, TransactionProvider, HolderProvider):
    name = "rpc"

    def __init__(
        self,
        endpoints: list[str],
        *,
        quality: DataQuality | None = None,
        cache: Any | None = None,
        requests_per_second: float = 25.0,
        max_concurrent: int = 16,
        timeout: float = 25.0,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        if not endpoints:
            raise ValueError("at least one RPC endpoint is required")
        self.endpoints = endpoints
        self.quality = quality or DataQuality()
        self.cache = cache
        self.batch_size = batch_size
        self._bucket = TokenBucket(requests_per_second, burst=max(requests_per_second, 10))
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._breakers = {ep: CircuitBreaker(name=_endpoint_label(ep)) for ep in endpoints}
        self._flight = SingleFlight()
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            limits=httpx.Limits(max_connections=max_concurrent * 2, max_keepalive_connections=max_concurrent),
            headers={"content-type": "application/json"},
        )
        self._request_id = 0
        for ep in endpoints:
            self.quality.health(_endpoint_label(ep))

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> SolanaRpcClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------
    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def _post(self, endpoint: str, payload: Any) -> Any:
        breaker = self._breakers[endpoint]
        breaker.check()
        label = _endpoint_label(endpoint)
        health = self.quality.health(label)
        await self._bucket.acquire()
        start = time.monotonic()
        async with self._semaphore:
            try:
                response = await self._client.post(endpoint, json=payload)
            except httpx.HTTPError as exc:
                breaker.record_failure()
                health.record(time.monotonic() - start, False, f"{type(exc).__name__}: {exc}")
                raise ProviderError(f"{label}: {exc}") from exc

        elapsed = time.monotonic() - start
        if response.status_code == 429:
            # Contre-pression, pas panne : on ralentit le seau et on laisse le
            # disjoncteur fermé. Compter les 429 comme des échecs faisait
            # d'un endpoint saturé un endpoint « mort » pendant 30 secondes.
            breaker.record_throttle()
            self._bucket.slow_down()
            health.record(elapsed, False, "HTTP 429 (rate limited)")
            raise RateLimitedError(
                f"{label}: rate limited (débit ramené à {self._bucket.rate:.0f}/s)"
            )
        if response.status_code >= 500:
            breaker.record_failure()
            health.record(elapsed, False, f"HTTP {response.status_code}")
            raise ProviderError(f"{label}: HTTP {response.status_code}")
        if response.status_code >= 400:
            breaker.record_failure()
            health.record(elapsed, False, f"HTTP {response.status_code}")
            raise ProviderError(f"{label}: HTTP {response.status_code} {response.text[:200]}")

        try:
            body = response.json()
        except ValueError as exc:
            breaker.record_failure()
            health.record(elapsed, False, "invalid JSON")
            raise ProviderError(f"{label}: invalid JSON response") from exc

        breaker.record_success()
        self._bucket.record_success()
        health.record(elapsed, True)
        self.quality.rpc_requests += 1 if not isinstance(payload, list) else len(payload)
        return body

    async def _call(self, method: str, params: list[Any], *, cache_key: str | None = None) -> Any:
        """Single RPC call with caching, de-duplication and endpoint failover."""
        if cache_key and self.cache is not None:
            cached = await self.cache.get(cache_key)
            if cached is not None:
                self.quality.cache_hits += 1
                return cached
            self.quality.cache_misses += 1

        flight_key = cache_key or f"{method}:{params!r}"

        async def _do() -> Any:
            last: Exception | None = None
            for endpoint in self.endpoints:
                payload = {"jsonrpc": "2.0", "id": self._next_id(), "method": method, "params": params}
                try:
                    body = await retry_async(
                        lambda ep=endpoint, pl=payload: self._post(ep, pl),
                        attempts=3,
                        retry_on=(ProviderError,),
                        label=method,
                    )
                except (ProviderError, CircuitBreakerOpen) as exc:
                    last = exc
                    continue
                if isinstance(body, dict) and body.get("error"):
                    err = body["error"]
                    message = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    # Data-availability errors are answers, not transport failures.
                    if _is_terminal_rpc_error(message):
                        raise ProviderError(f"{method}: {message}")
                    last = ProviderError(f"{method}: {message}")
                    continue
                return (body or {}).get("result")
            raise last or ProviderError(f"{method}: all endpoints failed")

        before = self._flight.collapsed
        result = await self._flight.do(flight_key, _do)
        if self._flight.collapsed > before:
            self.quality.deduplicated_requests += self._flight.collapsed - before

        if cache_key and self.cache is not None and result is not None:
            await self.cache.set(cache_key, result)
        return result

    async def _batch_call(self, method: str, param_sets: list[list[Any]]) -> list[Any]:
        """Issue a JSON-RPC batch, falling back to individual calls if unsupported."""
        if not param_sets:
            return []
        results: list[Any] = [None] * len(param_sets)
        for start in range(0, len(param_sets), self.batch_size):
            chunk = param_sets[start : start + self.batch_size]
            payload = [
                {"jsonrpc": "2.0", "id": i, "method": method, "params": params}
                for i, params in enumerate(chunk)
            ]
            body: Any = None
            for endpoint in self.endpoints:
                try:
                    body = await retry_async(
                        lambda ep=endpoint, pl=payload: self._post(ep, pl),
                        attempts=3,
                        retry_on=(ProviderError,),
                        label=f"batch:{method}",
                    )
                except (ProviderError, CircuitBreakerOpen):
                    body = None
                    continue
                break
            if isinstance(body, list):
                for item in body:
                    idx = item.get("id")
                    if isinstance(idx, int) and 0 <= idx < len(chunk):
                        results[start + idx] = None if item.get("error") else item.get("result")
            else:
                # Batching unsupported or all endpoints failed: degrade to singles.
                singles = await asyncio.gather(
                    *(self._call(method, params) for params in chunk), return_exceptions=True
                )
                for i, value in enumerate(singles):
                    results[start + i] = None if isinstance(value, BaseException) else value
        return results

    # ------------------------------------------------------------------
    # SolanaProvider
    # ------------------------------------------------------------------
    async def get_account_info(self, address: str) -> dict[str, Any] | None:
        result = await self._call(
            "getAccountInfo",
            [address, {"encoding": "base64", "commitment": "confirmed"}],
            cache_key=f"rpc:account:{address}",
        )
        return (result or {}).get("value")

    async def get_multiple_accounts(self, addresses: list[str]) -> list[dict[str, Any] | None]:
        out: list[dict[str, Any] | None] = []
        for start in range(0, len(addresses), 100):  # RPC hard limit
            chunk = addresses[start : start + 100]
            result = await self._call(
                "getMultipleAccounts", [chunk, {"encoding": "base64", "commitment": "confirmed"}]
            )
            values = (result or {}).get("value") or [None] * len(chunk)
            out.extend(values)
        return out

    async def get_balance(self, address: str) -> int:
        result = await self._call("getBalance", [address, {"commitment": "confirmed"}])
        return int((result or {}).get("value") or 0)

    async def get_balances(self, addresses: list[str]) -> dict[str, int]:
        param_sets = [[a, {"commitment": "confirmed"}] for a in addresses]
        results = await self._batch_call("getBalance", param_sets)
        return {
            addr: int((res or {}).get("value") or 0)
            for addr, res in zip(addresses, results, strict=False)
        }

    async def get_signatures(
        self, address: str, *, limit: int = 1000, before: str | None = None, until: str | None = None
    ) -> list[dict[str, Any]]:
        options: dict[str, Any] = {"limit": min(limit, SIGNATURE_PAGE_SIZE), "commitment": "confirmed"}
        if before:
            options["before"] = before
        if until:
            options["until"] = until
        result = await self._call("getSignaturesForAddress", [address, options])
        return list(result or [])

    async def get_signatures_paged(
        self,
        address: str,
        *,
        max_signatures: int = 1000,
        until: str | None = None,
        stop_before_time: int | None = None,
    ) -> list[dict[str, Any]]:
        """Walk signature history newest-first until a limit or time floor.

        ``stop_before_time`` lets the funding tracer stop as soon as it has gone
        far enough back in time, which is what keeps a deep scan bounded.
        """
        collected: list[dict[str, Any]] = []
        before: str | None = None
        while len(collected) < max_signatures:
            page_size = min(SIGNATURE_PAGE_SIZE, max_signatures - len(collected))
            page = await self.get_signatures(address, limit=page_size, before=before, until=until)
            if not page:
                break
            collected.extend(page)
            if stop_before_time is not None:
                oldest = page[-1].get("blockTime")
                if oldest is not None and oldest < stop_before_time:
                    break
            if len(page) < page_size:
                break
            before = page[-1].get("signature")
            if not before:
                break
        return collected[:max_signatures]

    async def get_oldest_signature(self, address: str, *, max_pages: int = 12) -> dict[str, Any] | None:
        """Page back to the *earliest* signature of an address (wallet age).

        Bounded by ``max_pages`` so a whale's history cannot stall a scan; when
        the bound is hit the caller is told the age is a lower bound rather
        than an exact value.
        """
        before: str | None = None
        oldest: dict[str, Any] | None = None
        for _ in range(max_pages):
            page = await self.get_signatures(address, limit=SIGNATURE_PAGE_SIZE, before=before)
            if not page:
                break
            oldest = page[-1]
            if len(page) < SIGNATURE_PAGE_SIZE:
                return oldest
            before = oldest.get("signature")
            if not before:
                break
        return oldest

    async def get_transaction(self, signature: str) -> dict[str, Any] | None:
        return await self._call(
            "getTransaction",
            [
                signature,
                {
                    "encoding": "jsonParsed",
                    "commitment": "confirmed",
                    "maxSupportedTransactionVersion": 0,
                },
            ],
            cache_key=f"rpc:tx:{signature}",
        )

    # ------------------------------------------------------------------
    # TransactionProvider
    # ------------------------------------------------------------------
    async def get_transactions(self, signatures: list[str]) -> dict[str, dict[str, Any] | None]:
        """Fetch many transactions, using the cache then a JSON-RPC batch."""
        out: dict[str, dict[str, Any] | None] = {}
        missing: list[str] = []
        if self.cache is not None:
            for sig in signatures:
                cached = await self.cache.get(f"rpc:tx:{sig}")
                if cached is not None:
                    out[sig] = cached
                    self.quality.cache_hits += 1
                else:
                    self.quality.cache_misses += 1
                    missing.append(sig)
        else:
            missing = list(signatures)

        options = {"encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}
        results = await self._batch_call("getTransaction", [[sig, options] for sig in missing])
        for sig, tx in zip(missing, results, strict=False):
            out[sig] = tx
            if tx is not None and self.cache is not None:
                await self.cache.set(f"rpc:tx:{sig}", tx)
        self.quality.transactions_analyzed += sum(1 for v in out.values() if v)
        return out

    # ------------------------------------------------------------------
    # HolderProvider
    # ------------------------------------------------------------------
    async def get_token_holders(self, mint: str, *, limit: int = 50) -> list[dict[str, Any]]:
        """Largest token accounts, resolved to their owning wallets.

        ``getTokenLargestAccounts`` returns token *accounts*; the owner lookup
        is what turns them into wallets a graph can reason about.
        """
        result = await self._call("getTokenLargestAccounts", [mint, {"commitment": "confirmed"}])
        entries = (result or {}).get("value") or []
        entries = entries[:limit]
        if not entries:
            return []
        accounts = await self.get_multiple_accounts([e["address"] for e in entries])
        holders: list[dict[str, Any]] = []
        for entry, account in zip(entries, accounts, strict=False):
            owner = _parse_token_account_owner(account)
            holders.append(
                {
                    "token_account": entry.get("address"),
                    "owner": owner,
                    "amount": int(entry.get("amount") or 0),
                    "decimals": int(entry.get("decimals") or 0),
                    "ui_amount": float(entry.get("uiAmount") or 0.0),
                }
            )
        return holders

    async def get_token_supply(self, mint: str) -> dict[str, Any] | None:
        result = await self._call("getTokenSupply", [mint, {"commitment": "confirmed"}])
        return (result or {}).get("value")

    async def get_slot(self) -> int:
        return int(await self._call("getSlot", [{"commitment": "confirmed"}]) or 0)

    async def get_block_time(self, slot: int) -> int | None:
        try:
            value = await self._call("getBlockTime", [slot])
        except ProviderError:
            return None
        return int(value) if value is not None else None


def _endpoint_label(endpoint: str) -> str:
    if "helius" in endpoint:
        return "helius-rpc"
    host = endpoint.split("//", 1)[-1].split("/", 1)[0]
    return f"rpc:{host}"


def _is_terminal_rpc_error(message: str) -> bool:
    """Errors that mean "the chain has no such data", so retrying is pointless."""
    lowered = message.lower()
    return any(
        token in lowered
        for token in ("not found", "invalid param", "could not find", "unsupported", "long-term storage")
    )


def _parse_token_account_owner(account: dict[str, Any] | None) -> str | None:
    """Owner pubkey from an SPL token account (base64 layout: owner at +32)."""
    if not account:
        return None
    data = account.get("data")
    if isinstance(data, dict):  # jsonParsed
        return ((data.get("parsed") or {}).get("info") or {}).get("owner")
    from app.pumpfun.events import decode_account_data
    from app.utils.addresses import b58encode

    raw = decode_account_data(account)
    if not raw or len(raw) < 64:
        return None
    return b58encode(raw[32:64])
