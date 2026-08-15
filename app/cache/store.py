"""Caching layer: Redis when available, in-process LRU otherwise.

TTLs are per key-prefix because the data has wildly different volatility: a
confirmed transaction is immutable forever, a bonding-curve account changes
every block.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from typing import Any

from app.utils.logging import get_logger

log = get_logger("CACHE")

#: prefix -> ttl seconds.  ``None`` means "immutable, keep as long as we can".
TTL_BY_PREFIX: dict[str, int] = {
    "rpc:tx": 86_400 * 7,  # confirmed transactions never change
    "rpc:account": 15,  # bonding curve / pool state is hot
    "rpc:sigs": 30,
    "helius:asset": 3_600,
    "solscan:account": 3_600,
    "wallet:profile": 300,
    "wallet:history": 900,
    "creator:history": 900,
    "token:profile": 30,
    "entity:label": 86_400,
}
DEFAULT_TTL = 300


def ttl_for(key: str) -> int:
    for prefix, ttl in TTL_BY_PREFIX.items():
        if key.startswith(prefix):
            return ttl
    return DEFAULT_TTL


class Cache:
    """Interface implemented by every backend."""

    async def get(self, key: str) -> Any | None:  # pragma: no cover - interface
        raise NotImplementedError

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:  # pragma: no cover
        raise NotImplementedError

    async def delete(self, key: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    async def aclose(self) -> None:  # pragma: no cover - interface
        return None


class MemoryCache(Cache):
    """Bounded LRU with per-entry expiry. Always available, zero infrastructure."""

    def __init__(self, max_entries: int = 20_000) -> None:
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._max = max_entries
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            expires, value = entry
            if expires and expires < time.time():
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        async with self._lock:
            expiry = time.time() + (ttl if ttl is not None else ttl_for(key))
            self._data[key] = (expiry, value)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._data.pop(key, None)


class RedisCache(Cache):
    """Redis-backed cache with a memory front for hot keys within one scan."""

    def __init__(self, client: Any, *, namespace: str = "pfbd", local: MemoryCache | None = None) -> None:
        self._redis = client
        self._ns = namespace
        self._local = local or MemoryCache(max_entries=5_000)

    def _key(self, key: str) -> str:
        return f"{self._ns}:{key}"

    async def get(self, key: str) -> Any | None:
        local = await self._local.get(key)
        if local is not None:
            return local
        try:
            raw = await self._redis.get(self._key(key))
        except Exception as exc:  # noqa: BLE001 - cache must never break a scan
            log.debug("redis get failed", key=key, error=str(exc))
            return None
        if raw is None:
            return None
        try:
            value = json.loads(raw)
        except (ValueError, TypeError):
            return None
        await self._local.set(key, value, ttl=min(60, ttl_for(key)))
        return value

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        seconds = ttl if ttl is not None else ttl_for(key)
        await self._local.set(key, value, ttl=min(60, seconds))
        try:
            await self._redis.set(self._key(key), json.dumps(value, default=str), ex=seconds)
        except Exception as exc:  # noqa: BLE001
            log.debug("redis set failed", key=key, error=str(exc))

    async def delete(self, key: str) -> None:
        await self._local.delete(key)
        try:
            await self._redis.delete(self._key(key))
        except Exception:  # noqa: BLE001
            pass

    async def aclose(self) -> None:
        try:
            await self._redis.aclose()
        except Exception:  # noqa: BLE001 - best effort
            pass


async def build_cache(redis_url: str | None) -> Cache:
    """Connect to Redis, falling back to memory when it is not reachable."""
    if not redis_url:
        return MemoryCache()
    try:
        import redis.asyncio as aioredis
    except ImportError:
        log.info("redis package unavailable, using in-memory cache")
        return MemoryCache()
    try:
        client = aioredis.from_url(redis_url, decode_responses=True)
        await client.ping()
    except Exception as exc:  # noqa: BLE001 - any connection problem
        log.info("redis unavailable, using in-memory cache", error=str(exc))
        return MemoryCache()
    log.info("redis connected")
    return RedisCache(client)
