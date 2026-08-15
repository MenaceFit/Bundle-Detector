"""Provider abstractions and the data-quality ledger.

Two ideas live here:

* the *interfaces* the analyzers are allowed to depend on (§72 of the spec:
  the scoring engine must never be coupled to a provider);
* the :class:`DataQuality` ledger, which records what each provider actually
  delivered during a scan.  Missing data lowers confidence rather than being
  silently filled in.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ProviderStatus(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"
    FAILED = "failed"
    DISABLED = "disabled"  # not configured (no API key)

    @property
    def icon(self) -> str:
        return {"ok": "✅", "degraded": "⚠️", "failed": "❌", "disabled": "➖"}[self.value]


@dataclass
class ProviderHealth:
    name: str
    status: ProviderStatus = ProviderStatus.DISABLED
    requests: int = 0
    failures: int = 0
    total_latency: float = 0.0
    last_error: str | None = None

    @property
    def avg_latency_ms(self) -> float:
        return (self.total_latency / self.requests * 1000.0) if self.requests else 0.0

    @property
    def success_rate(self) -> float:
        return 1.0 - (self.failures / self.requests) if self.requests else 0.0

    def record(self, latency: float, ok: bool, error: str | None = None) -> None:
        self.requests += 1
        self.total_latency += latency
        if ok:
            if self.status in (ProviderStatus.DISABLED, ProviderStatus.FAILED):
                self.status = ProviderStatus.OK
            elif self.status is ProviderStatus.DEGRADED and self.success_rate > 0.9:
                self.status = ProviderStatus.OK
        else:
            self.failures += 1
            self.last_error = error
            self.status = ProviderStatus.FAILED if self.success_rate < 0.5 else ProviderStatus.DEGRADED


class CoverageLevel(str, Enum):
    """How complete one *kind* of data turned out to be for a scan."""

    COMPLETE = "complete"
    PARTIAL = "partial"
    MISSING = "missing"

    @property
    def icon(self) -> str:
        return {"complete": "✅", "partial": "⚠️", "missing": "❌"}[self.value]

    @property
    def weight(self) -> float:
        return {"complete": 1.0, "partial": 0.5, "missing": 0.0}[self.value]


@dataclass
class DataQuality:
    """Per-scan ledger of provider health and data coverage."""

    providers: dict[str, ProviderHealth] = field(default_factory=dict)
    coverage: dict[str, CoverageLevel] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    # observability counters (§105)
    rpc_requests: int = 0
    api_requests: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    deduplicated_requests: int = 0
    wallets_analyzed: int = 0
    transactions_analyzed: int = 0
    clusters_detected: int = 0
    started_at: float = field(default_factory=time.monotonic)

    def health(self, name: str) -> ProviderHealth:
        return self.providers.setdefault(name, ProviderHealth(name=name))

    def set_coverage(self, key: str, level: CoverageLevel, note: str | None = None) -> None:
        self.coverage[key] = level
        if note:
            self.notes.append(note)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    def score(self) -> float:
        """Overall data quality in ``[0, 1]``.

        Half of the score comes from coverage of the analytical inputs, half
        from the health of the providers that were actually used.
        """
        if self.coverage:
            coverage_score = sum(level.weight for level in self.coverage.values()) / len(self.coverage)
        else:
            coverage_score = 0.0
        used = [h for h in self.providers.values() if h.requests > 0]
        provider_score = (sum(h.success_rate for h in used) / len(used)) if used else 0.0
        if not used:
            return coverage_score
        return 0.5 * coverage_score + 0.5 * provider_score

    def summary(self) -> dict[str, Any]:
        return {
            "score": self.score(),
            "providers": {
                name: {
                    "status": h.status.value,
                    "requests": h.requests,
                    "failures": h.failures,
                    "avg_latency_ms": round(h.avg_latency_ms, 1),
                    "last_error": h.last_error,
                }
                for name, h in self.providers.items()
            },
            "coverage": {k: v.value for k, v in self.coverage.items()},
            "counters": {
                "rpc_requests": self.rpc_requests,
                "api_requests": self.api_requests,
                "cache_hits": self.cache_hits,
                "cache_misses": self.cache_misses,
                "deduplicated_requests": self.deduplicated_requests,
                "wallets_analyzed": self.wallets_analyzed,
                "transactions_analyzed": self.transactions_analyzed,
                "clusters_detected": self.clusters_detected,
                "elapsed_seconds": round(self.elapsed, 2),
            },
            "notes": self.notes,
        }


class ProviderError(RuntimeError):
    """Any recoverable provider-side failure (HTTP, RPC error, timeout)."""


class RateLimitedError(ProviderError):
    """HTTP 429 / provider-signalled throttling."""


# ---------------------------------------------------------------------------
# Interfaces (§72)
# ---------------------------------------------------------------------------
class SolanaProvider(ABC):
    """Raw chain access: accounts, signatures, transactions, balances."""

    name: str

    @abstractmethod
    async def get_account_info(self, address: str) -> dict[str, Any] | None: ...

    @abstractmethod
    async def get_multiple_accounts(self, addresses: list[str]) -> list[dict[str, Any] | None]: ...

    @abstractmethod
    async def get_balance(self, address: str) -> int: ...

    @abstractmethod
    async def get_signatures(
        self, address: str, *, limit: int = 1000, before: str | None = None, until: str | None = None
    ) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def get_transaction(self, signature: str) -> dict[str, Any] | None: ...


class TransactionProvider(ABC):
    """Bulk / enriched transaction retrieval."""

    name: str

    @abstractmethod
    async def get_transactions(self, signatures: list[str]) -> dict[str, dict[str, Any] | None]: ...


class HolderProvider(ABC):
    """Token holder distribution."""

    name: str

    @abstractmethod
    async def get_token_holders(self, mint: str, *, limit: int = 50) -> list[dict[str, Any]]: ...


class PumpFunProvider(ABC):
    """Pump.fun-specific metadata (off-chain enrichment: socials, image, ...)."""

    name: str

    @abstractmethod
    async def get_token_metadata(self, mint: str) -> dict[str, Any] | None: ...
