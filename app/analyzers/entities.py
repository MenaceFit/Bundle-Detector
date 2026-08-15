"""Address classification (§42, §43, §44, §101).

Three layers, in decreasing order of certainty:

1. **Curated labels** — ``app/data/known_entities.json``. Programs and Pump's
   own accounts come from the IDL and Pump's docs; exchange labels are
   community-sourced and flagged ``verify``.
2. **Provider labels** — Solscan's ``account_label`` when a key is configured.
3. **Behavioural inference** — an address that fans out to a large number of
   distinct wallets, or that has an enormous transaction count, behaves like
   shared infrastructure regardless of whether anyone has labelled it.

Layer 3 is the important one.  The spec's exchange-funder problem (§43) says
that 40 wallets funded from a known exchange must not be reported as a
40-wallet bundle.  Relying on a label list to prevent that would fail the first
time an unlisted exchange or bot-funding service appeared.  Measuring fan-out
means the detector degrades gracefully instead: an unknown address that funded
200 distinct wallets is treated as probable infrastructure and its
"common funder" contribution is damped, with the reasoning shown in the report.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from app.config import DATA_DIR, ScoringConfig
from app.models.enums import EntityType
from app.utils.logging import get_logger

log = get_logger("WALLET")


@dataclass(slots=True)
class EntityLabel:
    address: str
    label: str | None
    entity_type: EntityType
    source: str
    confidence: float
    needs_verification: bool = False

    @property
    def is_infrastructure(self) -> bool:
        return self.entity_type.is_infrastructure


@lru_cache(maxsize=1)
def _load_registry() -> dict[str, EntityLabel]:
    path = DATA_DIR / "known_entities.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # pragma: no cover - packaging issue
        log.warning("known entity registry unavailable", error=str(exc))
        return {}
    registry: dict[str, EntityLabel] = {}
    for address, entry in (raw.get("entities") or {}).items():
        try:
            entity_type = EntityType(entry["entity_type"])
        except (KeyError, ValueError):
            continue
        registry[address] = EntityLabel(
            address=address,
            label=entry.get("label"),
            entity_type=entity_type,
            source=entry.get("source", "unknown"),
            confidence=float(entry.get("confidence", 0.5)),
            needs_verification=bool(entry.get("verify", False)),
        )
    return registry


def lookup(address: str) -> EntityLabel | None:
    return _load_registry().get(address)


def registry_size() -> int:
    return len(_load_registry())


@dataclass
class FunderAssessment:
    """What kind of thing a funding source appears to be, and how to weight it."""

    address: str
    entity_type: EntityType
    label: str | None = None
    source: str = "inferred"
    confidence: float = 0.0
    #: Distinct wallets in this scan that this address funded.
    fanout: int = 0
    #: Total signature count of the address, when known.
    activity: int | None = None
    #: Multiplier applied to this funder's coordination weight (0-1).
    weight: float = 1.0
    reason: str = ""

    @property
    def is_shared_infrastructure(self) -> bool:
        return self.weight < 1.0 or self.entity_type.is_infrastructure


class EntityClassifier:
    """Classifies addresses and decides how much a shared funder should count."""

    def __init__(self, config: ScoringConfig | None = None) -> None:
        self.config = config or ScoringConfig()
        self._provider_labels: dict[str, str] = {}
        self._observed_fanout: dict[str, set[str]] = {}
        self._activity: dict[str, int] = {}

    # ------------------------------------------------------------------
    def record_provider_label(self, address: str, label: str | None) -> None:
        if label:
            self._provider_labels[address] = label

    def record_activity(self, address: str, signature_count: int) -> None:
        self._activity[address] = max(self._activity.get(address, 0), signature_count)

    def record_funding(self, source: str, recipient: str) -> None:
        self._observed_fanout.setdefault(source, set()).add(recipient)

    def fanout(self, address: str) -> int:
        return len(self._observed_fanout.get(address, ()))

    # ------------------------------------------------------------------
    def classify(self, address: str, *, default: EntityType = EntityType.UNKNOWN) -> EntityLabel:
        known = lookup(address)
        if known:
            return known

        provider_label = self._provider_labels.get(address)
        if provider_label:
            inferred = _entity_from_label_text(provider_label)
            if inferred is not None:
                return EntityLabel(
                    address=address,
                    label=provider_label,
                    entity_type=inferred,
                    source="provider_label",
                    confidence=0.7,
                )
            return EntityLabel(
                address=address,
                label=provider_label,
                entity_type=default,
                source="provider_label",
                confidence=0.4,
            )
        return EntityLabel(address=address, label=None, entity_type=default, source="none", confidence=0.0)

    def assess_funder(self, address: str) -> FunderAssessment:
        """Decide how strongly a shared funder counts as evidence of coordination."""
        label = self.classify(address, default=EntityType.FUNDER)
        fanout = self.fanout(address)
        activity = self._activity.get(address)
        assessment = FunderAssessment(
            address=address,
            entity_type=label.entity_type,
            label=label.label,
            source=label.source,
            confidence=label.confidence,
            fanout=fanout,
            activity=activity,
        )

        if label.entity_type is EntityType.CEX:
            assessment.weight = self.config.infra_damping
            assessment.reason = (
                f"Funding came from {label.label or 'a known exchange'}. Shared exchange funding is "
                "expected between unrelated users and is treated as a weak signal."
            )
            return assessment

        if label.entity_type.is_infrastructure:
            assessment.weight = 0.0
            assessment.reason = (
                f"{label.label or 'Infrastructure address'} is protocol/program infrastructure, "
                "not a user wallet; it carries no coordination signal."
            )
            return assessment

        # Behavioural inference for unlabelled addresses.
        if fanout >= self.config.infra_fanout_threshold:
            assessment.entity_type = EntityType.INFRASTRUCTURE
            assessment.weight = self.config.infra_damping
            assessment.source = "inferred:fanout"
            assessment.reason = (
                f"This address funded {fanout} distinct wallets in this scan, which is the profile of a "
                "shared service (exchange, bot platform or wallet provider) rather than a single operator."
            )
            return assessment

        if activity is not None and activity >= self.config.infra_signature_threshold:
            assessment.entity_type = EntityType.INFRASTRUCTURE
            assessment.weight = self.config.infra_damping
            assessment.source = "inferred:activity"
            assessment.reason = (
                f"This address has at least {activity} transactions, an activity level typical of shared "
                "infrastructure rather than a private funding wallet."
            )
            return assessment

        assessment.entity_type = EntityType.FUNDER
        assessment.weight = 1.0
        assessment.reason = "No exchange, program or high-fan-out signature; treated as a private funder."
        return assessment


#: Keyword -> entity type, used to interpret free-form provider labels.
_LABEL_KEYWORDS: tuple[tuple[tuple[str, ...], EntityType], ...] = (
    (("binance", "coinbase", "kraken", "okx", "bybit", "bitget", "gate.io", "gateio", "mexc",
      "kucoin", "huobi", "htx", "crypto.com", "bitfinex", "upbit", "bithumb", "exchange"), EntityType.CEX),
    (("bridge", "wormhole", "allbridge", "debridge", "portal"), EntityType.BRIDGE),
    (("raydium", "orca", "meteora", "jupiter", "phoenix", "openbook", "serum", "lifinity",
      "dex", "amm", "swap"), EntityType.DEX),
    (("pump.fun", "pumpfun"), EntityType.PUMPFUN),
    (("pumpswap",), EntityType.PUMPSWAP),
    (("program", "authority", "sysvar"), EntityType.PROGRAM),
    (("vault", "treasury"), EntityType.VAULT),
    (("burn", "incinerator"), EntityType.BURN),
)


def _entity_from_label_text(text: str) -> EntityType | None:
    lowered = text.lower()
    for keywords, entity_type in _LABEL_KEYWORDS:
        if any(keyword in lowered for keyword in keywords):
            return entity_type
    return None


@dataclass
class ClassificationSummary:
    """Aggregate view used by the report and the bubble map legend."""

    by_type: dict[EntityType, list[str]] = field(default_factory=dict)

    def add(self, address: str, entity_type: EntityType) -> None:
        self.by_type.setdefault(entity_type, []).append(address)

    def as_dict(self) -> dict[str, list[str]]:
        return {k.value: v for k, v in self.by_type.items()}


def describe_registry() -> dict[str, Any]:
    """Registry stats, surfaced by ``/settings`` so operators can audit labels."""
    registry = _load_registry()
    counts: dict[str, int] = {}
    unverified = 0
    for entry in registry.values():
        counts[entry.entity_type.value] = counts.get(entry.entity_type.value, 0) + 1
        if entry.needs_verification:
            unverified += 1
    return {"total": len(registry), "by_type": counts, "needs_verification": unverified}
