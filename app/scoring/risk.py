"""Risk engine (§84, §110, §111, §112).

Takes every measured signal and produces the multi-dimensional score set, the
classification and the final verdict.

The classification step is the part that matters most for accuracy.  A high
coordination score has several possible causes, and the engine is required to
tell them apart rather than labelling all of them "bundle":

* a **bundle** — one operator, several wallets, private funding;
* **CEX-funded users** — the shared funder is an exchange;
* **professional snipers** — experienced, independently funded, always early;
* **MEV / automation** — same-block execution without funding relationships;
* **Mayhem activity** — protocol-driven trades;
* **normal early buyers**;
* **insufficient data**.

Ranking runs from the most specific benign explanation to the least, so a
benign explanation that fits the evidence wins over the alarming one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.config import ScoringConfig, Settings
from app.models.cluster import Cluster, ClusterSignals
from app.models.enums import Classification, RiskLevel
from app.models.scoring import ConfidenceReport, RiskReport, ScoreBreakdown
from app.models.wallet import CreatorProfile, WalletProfile
from app.providers.base import DataQuality
from app.scoring import bundle as bundle_scoring
from app.scoring import confidence as confidence_engine
from app.scoring import coordination
from app.utils.logging import get_logger
from app.utils.stats import scale_to_100

log = get_logger("SCORE")

#: A wallet with at least this many previous Pump.fun launches is experienced.
EXPERIENCED_LAUNCH_COUNT = 15
#: Share of cluster members that must be experienced for the sniper reading.
SNIPER_SHARE = 0.6


@dataclass
class RiskInputs:
    """Everything the engine needs, gathered by the orchestrator."""

    cluster: Cluster | None
    signals: ClusterSignals
    profiles: dict[str, WalletProfile]
    creator: CreatorProfile | None
    quality: DataQuality
    context: bundle_scoring.BundleContext
    wallets_analyzed: int
    history_coverage: float = 0.0
    mayhem_enabled: bool = False
    mayhem_activity: int = 0
    sell_coordination: float = 0.0
    same_slot_wallets: int = 0
    bounded_ages: int = 0
    members: list[str] = field(default_factory=list)


class RiskEngine:
    def __init__(self, settings: Settings | None = None) -> None:
        from app.config import get_settings

        self.settings = settings or get_settings()
        self.config: ScoringConfig = self.settings.scoring

    def evaluate(self, inputs: RiskInputs) -> RiskReport:
        report = RiskReport()

        breakdown = bundle_scoring.compute(
            inputs.signals,
            weights=self.config.weights,
            config=self.config,
            context=inputs.context,
        )
        report.bundle = breakdown

        report.funding_coordination = coordination.funding_coordination(inputs.signals)
        report.buy_coordination = coordination.buy_coordination(inputs.signals)
        report.wallet_cluster = _cluster_score(inputs.cluster, breakdown)
        report.creator_link = scale_to_100(inputs.signals.creator_linkage)
        report.historical_pattern = scale_to_100(inputs.signals.historical_overlap)
        report.sell_coordination = scale_to_100(inputs.sell_coordination)
        report.mayhem_activity = inputs.mayhem_activity
        report.early_buyer_risk = _early_buyer_risk(inputs.profiles, inputs.members)
        report.dev_risk = inputs.creator.risk_score if inputs.creator else 0

        contradictions = confidence_engine.detect_contradictions(
            signals=inputs.signals,
            infrastructure_funder=inputs.context.funder_is_infrastructure,
            mayhem_enabled=inputs.mayhem_enabled,
            unobserved_funding_share=inputs.context.unobserved_share,
            bounded_ages=inputs.bounded_ages,
        )
        report.confidence = confidence_engine.compute(
            wallets_analyzed=inputs.wallets_analyzed,
            signals=inputs.signals,
            quality=inputs.quality,
            history_coverage=inputs.history_coverage,
            contradictions=contradictions,
            config=self.config,
        )

        report.overall_risk = _overall_risk(report)
        report.classification = self.classify(inputs, report)
        report.risk_level = self.level_for(report.overall_risk)
        log.info(
            "risk evaluated",
            bundle=report.bundle.score,
            overall=report.overall_risk,
            confidence=report.confidence.score,
            classification=report.classification.value,
        )
        return report

    # ------------------------------------------------------------------
    def classify(self, inputs: RiskInputs, report: RiskReport) -> Classification:
        members = inputs.members or list(inputs.profiles)
        member_count = len(members)

        if member_count < self.config.min_cluster_size or report.confidence.score < 25:
            return Classification.INSUFFICIENT_DATA

        # Protocol automation explains coordinated-looking activity outright.
        if inputs.mayhem_enabled and inputs.mayhem_activity >= 50:
            return Classification.MAYHEM_ACTIVITY

        # A shared exchange funder with nothing else is the classic false positive.
        if inputs.context.funder_is_infrastructure and report.bundle.independent_signals <= 1:
            return Classification.CEX_FUNDED_USERS

        # Same-block entries without any funding relationship read as automation,
        # not as one operator: bundlers fund their wallets, bots do not need to.
        if (
            inputs.same_slot_wallets >= 3
            and inputs.signals.common_funder < 0.2
            and inputs.signals.common_intermediary < 0.2
        ):
            return Classification.AUTOMATED_ACTIVITY

        experienced = sum(
            1
            for m in members
            if (p := inputs.profiles.get(m))
            and p.pumpfun_launches is not None
            and p.pumpfun_launches >= EXPERIENCED_LAUNCH_COUNT
        )
        if (
            member_count
            and experienced / member_count >= SNIPER_SHARE
            and inputs.signals.common_funder < 0.3
            and inputs.signals.creator_linkage == 0
        ):
            return Classification.PROFESSIONAL_SNIPERS

        if report.bundle.score >= 70 and report.bundle.independent_signals >= self.config.min_independent_signals:
            return Classification.BUNDLE
        if report.bundle.score >= 45:
            return Classification.POSSIBLE_COORDINATION
        return Classification.NORMAL_EARLY_BUYERS

    def level_for(self, score: int) -> RiskLevel:
        alerts = self.settings.alerts
        if score <= alerts.low_max:
            return RiskLevel.LOW
        if score <= alerts.medium_max:
            return RiskLevel.MEDIUM
        if score <= alerts.high_max:
            return RiskLevel.HIGH
        return RiskLevel.CRITICAL


def _cluster_score(cluster: Cluster | None, breakdown: ScoreBreakdown) -> int:
    if cluster is None:
        return 0
    # Cluster strength blends the bundle evidence with how large and how
    # multiply-confirmed the group is.
    size_factor = min(1.0, cluster.size / 10.0)
    confirmation = 1.0 if "+" in cluster.method else 0.8
    return int(round(min(100.0, breakdown.score * (0.7 + 0.3 * size_factor) * confirmation)))


def _early_buyer_risk(profiles: dict[str, WalletProfile], members: list[str]) -> int:
    targets = [profiles[m] for m in (members or list(profiles)) if m in profiles]
    scored = [p.risk_score for p in targets if not p.entity_type.is_infrastructure]
    if not scored:
        return 0
    scored.sort(reverse=True)
    # Mean of the worst third: one risky wallet should not define the launch,
    # but a concentration of them should.
    top = scored[: max(1, len(scored) // 3)]
    return int(round(sum(top) / len(top)))


def _overall_risk(report: RiskReport) -> int:
    """Overall risk is dominated by the bundle score, tempered by confidence.

    Low confidence pulls the overall number down because the overall figure is
    what a reader acts on; the raw bundle score stays visible and unmodified
    next to it so nothing is hidden.
    """
    base = (
        0.50 * report.bundle.score
        + 0.15 * report.wallet_cluster
        + 0.15 * report.dev_risk
        + 0.10 * report.early_buyer_risk
        + 0.10 * report.sell_coordination
    )
    confidence_factor = 0.55 + 0.45 * (report.confidence.score / 100.0)
    return int(round(max(0.0, min(100.0, base * confidence_factor))))


def verdict_lines(report: RiskReport) -> list[str]:
    """The final verdict block (§112), always shown *after* the evidence."""
    level = report.risk_level
    return [
        f"{level.emoji} {level.value}",
        report.classification.verdict_text,
        f"Bundle score {report.bundle.score}/100 · confidence {report.confidence.score}% "
        f"({report.confidence.level})",
    ]


def build_confidence_only(
    *, quality: DataQuality, wallets_analyzed: int, history_coverage: float = 0.0
) -> ConfidenceReport:
    """Confidence for scans that produced no cluster (nothing to score)."""
    return confidence_engine.compute(
        wallets_analyzed=wallets_analyzed,
        signals=None,
        quality=quality,
        history_coverage=history_coverage,
    )
