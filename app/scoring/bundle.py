"""Bundle score (§45, §46, §85).

The score is a weighted sum of bounded contributions, but the weighting is not
the interesting part — the **independence rule** is.

Signals are grouped into families that measure genuinely different things:

===========================  ===============================================
family                       what it observes
===========================  ===============================================
``funding_topology``         who paid for the wallets (shared funder / hop)
``funding_pattern``          how the payments looked (size, synchronisation)
``trade_pattern``            how the buys looked (size, synchronisation)
``wallet_provenance``        what the wallets themselves are (age profile)
``history``                  whether these wallets have done this before
``creator``                  whether the launcher is connected to the buyers
===========================  ===============================================

Signals inside a family are highly correlated: wallets funded by one person
naturally receive similar amounts at similar times, so ``funding_pattern``
firing tells you almost nothing new once ``funding_topology`` has fired.  The
score therefore caps hard unless several *families* agree:

* fewer than 2 families            -> capped at ``single_signal_ceiling`` (35)
* exactly ``min-1`` families       -> capped at ``two_signal_ceiling`` (55)
* ``min_independent_signals`` +    -> uncapped

This is the direct implementation of the spec's absolute rule: five wallets
funded with about 5 SOL each is *not* a bundle, and the engine is structurally
incapable of calling it one until independent evidence joins it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.config import BundleWeights, ScoringConfig
from app.models.cluster import Cluster, ClusterSignals
from app.models.scoring import ScoreBreakdown, ScoreContribution
from app.utils.logging import get_logger

log = get_logger("SCORE")

#: signal name -> (weight attribute, family, human label)
SIGNAL_MAP: dict[str, tuple[str, str, str]] = {
    "common_funder": ("common_direct_funder", "funding_topology", "Common funding source"),
    "common_intermediary": ("common_intermediary", "funding_topology", "Common intermediary"),
    # Famille propre : la *construction* des transactions est une question
    # distincte du financement (qui a payé) comme du cadencement (quand).
    # Un opérateur peut financer depuis un wallet et signer depuis un autre.
    "shared_signer": ("shared_signer", "execution", "Shared transaction signer"),
    "funding_amount_similarity": ("funding_amount_similarity", "funding_pattern", "Funding size similarity"),
    "funding_timing_similarity": ("funding_timing_similarity", "funding_pattern", "Funding synchronisation"),
    "buy_amount_similarity": ("buy_amount_similarity", "trade_pattern", "Purchase size similarity"),
    "buy_timing_similarity": ("buy_timing_similarity", "trade_pattern", "Purchase synchronisation"),
    "wallet_age_similarity": ("wallet_age_similarity", "wallet_provenance", "Wallet age similarity"),
    "historical_overlap": ("historical_overlap", "history", "Historical overlap"),
    "repeated_cluster": ("repeated_cluster", "history", "Repeated cluster across launches"),
    "creator_linkage": ("creator_linkage", "creator", "Creator linkage"),
}

#: A family counts as "fired" when it reaches this fraction of its own maximum.
FAMILY_FIRE_THRESHOLD = 0.40


@dataclass
class BundleContext:
    """Facts that damp or augment the raw signals."""

    #: Funder address -> damping multiplier (<1 for exchanges / infrastructure).
    funder_damping: dict[str, float] = field(default_factory=dict)
    #: Reason strings keyed by funder, shown in the breakdown.
    funder_reasons: dict[str, str] = field(default_factory=dict)
    #: Share of the cluster's trades that were Mayhem-flagged (§88).
    mayhem_share: float = 0.0
    #: Fraction of cluster members that are freshly created wallets.
    fresh_share: float = 0.0
    #: Wallets in the cluster whose funding could not be observed at all.
    unobserved_share: float = 0.0
    #: Sell-coordination measurement, folded into "other anomalies".
    sell_coordination: float = 0.0
    #: True when the cluster's shared funder was classified as infrastructure.
    funder_is_infrastructure: bool = False
    infrastructure_reason: str | None = None
    #: Share of the cluster's members that bought inside a *single* transaction
    #: alongside at least one other member (§21).
    atomic_share: float = 0.0
    #: Largest number of distinct cluster members observed in one transaction.
    atomic_group_size: int = 0


def compute(
    signals: ClusterSignals,
    *,
    weights: BundleWeights | None = None,
    config: ScoringConfig | None = None,
    context: BundleContext | None = None,
) -> ScoreBreakdown:
    weights = weights or BundleWeights()
    config = config or ScoringConfig()
    context = context or BundleContext()

    breakdown = ScoreBreakdown()
    family_points: dict[str, float] = {}
    family_max: dict[str, float] = {}

    raw = signals.as_dict()
    for signal_name, (weight_attr, family, label) in SIGNAL_MAP.items():
        max_points = float(getattr(weights, weight_attr))
        value = float(raw.get(signal_name, 0.0))
        damping, reason = _damping_for(signal_name, context)
        points = max_points * max(0.0, min(1.0, value)) * damping

        family_max[family] = family_max.get(family, 0.0) + max_points
        family_points[family] = family_points.get(family, 0.0) + points

        if points > 0 or value > 0:
            breakdown.contributions.append(
                ScoreContribution(
                    name=signal_name,
                    label=label,
                    points=round(points, 2),
                    max_points=max_points,
                    raw_signal=round(value, 4),
                    damping_reason=reason if damping < 1.0 else None,
                )
            )

    other_points, other_reason = _other_anomalies(context, weights)
    if other_points > 0:
        breakdown.contributions.append(
            ScoreContribution(
                name="other_anomalies",
                label="Other anomalies",
                points=round(other_points, 2),
                max_points=weights.other_anomalies,
                raw_signal=round(other_points / weights.other_anomalies, 4) if weights.other_anomalies else 0.0,
                damping_reason=other_reason,
            )
        )

    total = sum(c.points for c in breakdown.contributions)

    fired = [
        family
        for family, points in family_points.items()
        if family_max.get(family) and points / family_max[family] >= FAMILY_FIRE_THRESHOLD
    ]
    breakdown.independent_signals = len(fired)

    ceiling = _ceiling_for(len(fired), config)
    if ceiling is not None and total > ceiling:
        breakdown.ceiling_applied = ceiling
        total = ceiling

    total = _apply_atomic_floor(total, breakdown, fired=len(fired), config=config, context=context)

    breakdown.score = int(round(max(0.0, min(100.0, total))))
    log.info(
        "bundle scored",
        score=breakdown.score,
        families=len(fired),
        ceiling=breakdown.ceiling_applied,
    )
    return breakdown


def _apply_atomic_floor(
    total: float,
    breakdown: ScoreBreakdown,
    *,
    fired: int,
    config: ScoringConfig,
    context: BundleContext,
) -> float:
    """Raise the score to a floor when execution was provably atomic (§21).

    Every other signal in the engine is circumstantial: a shared funder can be a
    generous friend, matching amounts can be a copied strategy, identical timing
    can be two bots racing the same block.  Atomic execution is not.  A Solana
    transaction is only valid once every account that spends has signed it, so
    several *distinct* buyers inside one transaction means one party held all of
    those keys at the moment the transaction was assembled.

    The floor is deliberately gated on the independence rule (§46) still being
    satisfied: it lifts a well-corroborated case to the band it belongs in, and
    is structurally incapable of turning a lone signal into a verdict.
    """
    if context.atomic_group_size < 2:
        return total
    if context.atomic_share < config.atomic_execution_share:
        return total
    if fired < config.min_independent_signals:
        # L'atomicité est décisive, mais la règle d'indépendance reste absolue :
        # sans corroboration, le plafond s'applique tel quel.
        return total
    if breakdown.ceiling_applied is not None:
        return total
    if total >= config.atomic_execution_floor:
        return total

    breakdown.floor_applied = config.atomic_execution_floor
    breakdown.floor_reason = (
        f"{context.atomic_group_size} distinct buyers executed inside a single transaction "
        f"({context.atomic_share * 100:.0f}% of the cluster). A transaction is only valid once "
        "every spending account has signed it, so one party assembled all of those signatures."
    )
    return config.atomic_execution_floor


def _ceiling_for(fired: int, config: ScoringConfig) -> float | None:
    if fired >= config.min_independent_signals:
        return None
    if fired >= config.min_independent_signals - 1:
        return config.two_signal_ceiling
    return config.single_signal_ceiling


def _damping_for(signal_name: str, context: BundleContext) -> tuple[float, str | None]:
    """Damping applied to one signal before it contributes points."""
    if signal_name in {"common_funder", "common_intermediary"} and context.funder_is_infrastructure:
        return (
            0.2,
            context.infrastructure_reason
            or "The shared funder behaves like shared infrastructure (exchange or bot service), "
            "which is expected between unrelated users.",
        )
    if signal_name in {"buy_timing_similarity", "buy_amount_similarity"} and context.mayhem_share > 0:
        # Mayhem Mode produces protocol-automated trades whose timing and sizing
        # look coordinated by construction. Damp proportionally to how much of
        # the activity it accounts for.
        factor = max(0.0, 1.0 - context.mayhem_share)
        if factor < 1.0:
            return (
                factor,
                f"Mayhem Mode accounted for {context.mayhem_share * 100:.0f}% of the observed trades; "
                "automated activity is discounted from coordination signals.",
            )
    return 1.0, None


def _other_anomalies(context: BundleContext, weights: BundleWeights) -> tuple[float, str | None]:
    """Residual signals that do not have a dedicated weight.

    Fresh-wallet concentration and coordinated exits live here.  Neither can
    reach the main families, so neither can lift the score past a ceiling on
    its own — which is the point: a swarm of new wallets is a *signal*, not a
    verdict (§13).
    """
    fresh = max(0.0, min(1.0, context.fresh_share))
    sells = max(0.0, min(1.0, context.sell_coordination))
    combined = 0.6 * fresh + 0.4 * sells
    points = weights.other_anomalies * combined
    if points <= 0:
        return 0.0, None
    parts = []
    if fresh > 0:
        parts.append(f"{fresh * 100:.0f}% of members are freshly created wallets")
    if sells > 0:
        parts.append(f"exit coordination {sells * 100:.0f}%")
    return points, "; ".join(parts) if parts else None


def apply_to_cluster(
    cluster: Cluster,
    *,
    weights: BundleWeights | None = None,
    config: ScoringConfig | None = None,
    context: BundleContext | None = None,
) -> ScoreBreakdown:
    breakdown = compute(cluster.signals, weights=weights, config=config, context=context)
    cluster.score = breakdown.score
    return breakdown


def explain(breakdown: ScoreBreakdown) -> list[str]:
    """Human-readable lines for the explainable-score block (§85)."""
    lines = [f"+{c.points:.0f} {c.label}" for c in breakdown.top_contributions()]
    if breakdown.floor_applied is not None:
        lines.append(
            f"Score raised to {breakdown.floor_applied:.0f}: {breakdown.floor_reason}"
        )
    if breakdown.ceiling_applied is not None:
        lines.append(
            f"Score capped at {breakdown.ceiling_applied:.0f}: only {breakdown.independent_signals} "
            "independent signal family/families fired. Independent corroboration is required "
            "before a higher score can be produced."
        )
    return lines
