"""Rate limiting, retries, circuit breaking and request de-duplication.

These are the pieces that keep the engine polite towards RPC providers while
still finishing a full scan in seconds.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from app.utils.errors import CircuitBreakerOpen
from app.utils.logging import get_logger

log = get_logger("API")

T = TypeVar("T")


class TokenBucket:
    """Seau à jetons, avec adaptation automatique au throttling.

    Un endpoint gratuit annonce rarement sa limite réelle. Plutôt que d'exiger
    de l'utilisateur qu'il devine la bonne valeur, le seau se cale tout seul :
    chaque 429 divise le débit par deux, et le débit remonte progressivement
    quand les réponses repassent au vert.
    """

    #: Plancher : en dessous, plus rien n'avance.
    MIN_RATE = 1.0
    #: Facteur appliqué à chaque throttle.
    BACKOFF = 0.5
    #: Regain par succès consécutif, une fois le quota de récupération atteint.
    RECOVERY_STEP = 1.05
    #: Succès consécutifs requis avant de tenter de réaccélérer.
    RECOVERY_AFTER = 25

    def __init__(self, rate_per_second: float, burst: float | None = None) -> None:
        self.configured_rate = max(0.1, float(rate_per_second))
        self.rate = self.configured_rate
        self.capacity = float(burst if burst is not None else max(1.0, rate_per_second))
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()
        self._successes = 0
        self.throttle_events = 0

    def slow_down(self) -> float:
        """Appelé sur un 429. Renvoie le nouveau débit."""
        self.throttle_events += 1
        self._successes = 0
        self.rate = max(self.MIN_RATE, self.rate * self.BACKOFF)
        self.capacity = max(1.0, min(self.capacity, self.rate))
        log.info("rate limited, slowing down", rate=round(self.rate, 2))
        return self.rate

    def record_success(self) -> None:
        """Réaccélère prudemment après une série de succès."""
        if self.rate >= self.configured_rate:
            return
        self._successes += 1
        if self._successes >= self.RECOVERY_AFTER:
            self._successes = 0
            self.rate = min(self.configured_rate, self.rate * self.RECOVERY_STEP)

    async def acquire(self, tokens: float = 1.0) -> None:
        while True:
            async with self._lock:
                now = time.monotonic()
                self._tokens = min(self.capacity, self._tokens + (now - self._updated) * self.rate)
                self._updated = now
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return
                deficit = tokens - self._tokens
                wait = deficit / self.rate
            await asyncio.sleep(min(wait, 1.0))


@dataclass
class CircuitBreaker:
    """Se déclenche après `threshold` échecs *durs* consécutifs.

    Le throttling en est délibérément exclu (voir `record_throttle`) : un 429
    veut dire « ralentis », pas « le fournisseur est mort ». Compter les 429
    comme des pannes transformait un ralentissement passager en indisponibilité
    de 30 secondes, et cassait des scans qui n'avaient besoin que d'attendre.
    """

    name: str
    threshold: int = 5
    cooldown: float = 30.0
    _failures: int = field(default=0, init=False)
    _opened_at: float | None = field(default=None, init=False)
    #: Nombre de throttles observés, pour l'observabilité uniquement.
    throttles: int = field(default=0, init=False)

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        if time.monotonic() - self._opened_at >= self.cooldown:
            # half-open: allow a probe through
            self._opened_at = None
            self._failures = self.threshold - 1
            return False
        return True

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.threshold and self._opened_at is None:
            self._opened_at = time.monotonic()
            log.warning("circuit opened", provider=self.name, failures=self._failures)

    def record_throttle(self) -> None:
        """Un 429 : on ralentit, on n'écarte pas le fournisseur.

        Il réinitialise aussi le compteur d'échecs durs : le fournisseur a
        répondu, donc il est vivant — c'est l'inverse d'une panne.
        """
        self.throttles += 1
        self._failures = 0

    def check(self) -> None:
        if self.is_open:
            raise CircuitBreakerOpen(f"{self.name} circuit is open")


async def retry_async(
    func: Callable[[], Awaitable[T]],
    *,
    attempts: int = 4,
    base_delay: float = 0.4,
    max_delay: float = 8.0,
    retry_on: tuple[type[BaseException], ...] = (Exception,),
    give_up_on: tuple[type[BaseException], ...] = (asyncio.CancelledError, CircuitBreakerOpen),
    label: str = "request",
) -> T:
    """Exponential backoff with full jitter."""
    last: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await func()
        except give_up_on:
            raise
        except retry_on as exc:
            last = exc
            if attempt == attempts:
                break
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            delay = random.uniform(0, delay)  # full jitter
            log.debug("retrying", label=label, attempt=attempt, delay=round(delay, 3), error=type(exc).__name__)
            await asyncio.sleep(delay)
    assert last is not None
    raise last


class SingleFlight:
    """Collapses concurrent identical requests into one in-flight call.

    Section 76 of the spec: if several wallets need the same piece of data, the
    request must not be issued twice.
    """

    def __init__(self) -> None:
        self._inflight: dict[str, asyncio.Future[Any]] = {}
        self.collapsed = 0

    async def do(self, key: str, func: Callable[[], Awaitable[T]]) -> T:
        existing = self._inflight.get(key)
        if existing is not None:
            self.collapsed += 1
            return await asyncio.shield(existing)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._inflight[key] = future
        try:
            result = await func()
        except BaseException as exc:  # noqa: BLE001 - propagated to all waiters
            if not future.done():
                future.set_exception(exc)
            self._inflight.pop(key, None)
            # Ensure the exception is always retrieved, avoiding "never retrieved" noise.
            future.exception()
            raise
        else:
            if not future.done():
                future.set_result(result)
            self._inflight.pop(key, None)
            return result


async def gather_limited(
    coros: list[Awaitable[T]], *, limit: int, return_exceptions: bool = True
) -> list[T | BaseException]:
    """`asyncio.gather` with a concurrency ceiling."""
    semaphore = asyncio.Semaphore(max(1, limit))

    async def _run(coro: Awaitable[T]) -> T:
        async with semaphore:
            return await coro

    return await asyncio.gather(*(_run(c) for c in coros), return_exceptions=return_exceptions)
