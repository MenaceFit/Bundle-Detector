"""Holder distribution analysis.

Holders answer "who is exposed *now*", which is a different question from
"who bought early".  Both matter: a cluster that bought early and still holds
is a different risk from one that has already exited.

Concentration is reported with the Gini coefficient and top-N shares, with
program-owned accounts (the bonding curve, the PumpSwap pool vaults) excluded —
counting a protocol vault as a "holder" would make every coin look
concentrated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.analyzers.entities import EntityClassifier
from app.models.enums import EntityType
from app.utils.stats import gini


@dataclass
class HolderAnalysis:
    holders: list[dict[str, Any]] = field(default_factory=list)
    excluded: list[dict[str, Any]] = field(default_factory=list)
    total_held: float = 0.0
    top_1_share: float = 0.0
    top_5_share: float = 0.0
    top_10_share: float = 0.0
    gini: float = 0.0
    holder_count: int = 0

    def owners(self, limit: int = 50) -> list[str]:
        return [h["owner"] for h in self.holders[:limit] if h.get("owner")]


def analyze_holders(
    raw_holders: list[dict[str, Any]],
    classifier: EntityClassifier,
    *,
    infrastructure_addresses: set[str] | None = None,
) -> HolderAnalysis:
    analysis = HolderAnalysis()
    infra = infrastructure_addresses or set()

    for holder in raw_holders:
        owner = holder.get("owner")
        amount = float(holder.get("amount") or 0)
        if not owner or amount <= 0:
            continue
        label = classifier.classify(owner, default=EntityType.UNKNOWN)
        if owner in infra or label.entity_type.is_infrastructure:
            analysis.excluded.append({**holder, "reason": label.label or "protocol account"})
            continue
        analysis.holders.append({**holder, "label": label.label})

    analysis.holders.sort(key=lambda h: float(h.get("amount") or 0), reverse=True)
    amounts = [float(h.get("amount") or 0) for h in analysis.holders]
    analysis.total_held = sum(amounts)
    analysis.holder_count = len(amounts)
    analysis.gini = gini(amounts)

    if analysis.total_held > 0:
        analysis.top_1_share = sum(amounts[:1]) / analysis.total_held
        analysis.top_5_share = sum(amounts[:5]) / analysis.total_held
        analysis.top_10_share = sum(amounts[:10]) / analysis.total_held
    return analysis
