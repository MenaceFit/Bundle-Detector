"""Scores, evidence and the final report container."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.models.cluster import Cluster
from app.models.enums import Classification, RiskLevel, ScanDepth
from app.models.token import TokenProfile
from app.models.wallet import CreatorProfile, WalletProfile


class Evidence(BaseModel):
    """One traceable finding. Evidence comes *before* the verdict (§113)."""

    code: str
    title: str
    detail: str
    #: Wallets the finding concerns.
    wallets: list[str] = Field(default_factory=list)
    #: On-chain signatures backing the claim. Empty means "not directly traceable".
    signatures: list[str] = Field(default_factory=list)
    #: Strength in ``[0, 1]`` — how much this pushes the score.
    strength: float = 0.0
    #: Explicit statement of what this evidence does *not* prove.
    caveat: str | None = None

    @property
    def is_traceable(self) -> bool:
        return bool(self.signatures)


class ScoreContribution(BaseModel):
    """A single line of the explainable score breakdown (§85)."""

    name: str
    label: str
    points: float
    max_points: float
    raw_signal: float
    #: Why the contribution was damped, if it was.
    damping_reason: str | None = None


class ScoreBreakdown(BaseModel):
    score: int = 0
    contributions: list[ScoreContribution] = Field(default_factory=list)
    #: Number of independent signal families that fired.
    independent_signals: int = 0
    #: Ceiling applied because too few independent signals fired, if any.
    ceiling_applied: float | None = None

    def top_contributions(self, n: int = 8) -> list[ScoreContribution]:
        return sorted(
            (c for c in self.contributions if c.points > 0), key=lambda c: c.points, reverse=True
        )[:n]


class ConfidenceReport(BaseModel):
    score: int = 0
    level: str = "LOW"
    factors: dict[str, float] = Field(default_factory=dict)
    limitations: list[str] = Field(default_factory=list)


class RiskReport(BaseModel):
    """The multi-dimensional score set (§111)."""

    bundle: ScoreBreakdown = Field(default_factory=ScoreBreakdown)
    funding_coordination: int = 0
    buy_coordination: int = 0
    wallet_cluster: int = 0
    creator_link: int = 0
    historical_pattern: int = 0
    sell_coordination: int = 0
    mayhem_activity: int = 0
    early_buyer_risk: int = 0
    dev_risk: int = 0
    overall_risk: int = 0

    confidence: ConfidenceReport = Field(default_factory=ConfidenceReport)
    classification: Classification = Classification.INSUFFICIENT_DATA
    risk_level: RiskLevel = RiskLevel.LOW

    @property
    def bundle_score(self) -> int:
        return self.bundle.score


DISCLAIMER_EN = (
    "This is a probabilistic analysis based on observable on-chain patterns. "
    "It does not prove wallet ownership or intent."
)
DISCLAIMER_FR = (
    "Cette analyse est probabiliste et repose sur des comportements observables on-chain. "
    "Elle ne constitue pas une preuve certaine que plusieurs wallets appartiennent à la même personne."
)


class ScanReport(BaseModel):
    """The complete result of one scan — everything a report or export needs."""

    mint: str
    depth: ScanDepth = ScanDepth.FULL
    token: TokenProfile
    creator: CreatorProfile | None = None

    wallets: list[WalletProfile] = Field(default_factory=list)
    first_buyers: list[str] = Field(default_factory=list)
    holders: list[dict] = Field(default_factory=list)
    clusters: list[Cluster] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    risk: RiskReport = Field(default_factory=RiskReport)

    #: Buyer counts per configured analysis window.
    window_counts: dict[str, int] = Field(default_factory=dict)
    #: Cumulative buyer counts at the timeline checkpoints (§10).
    timeline: dict[str, int] = Field(default_factory=dict)
    fresh_wallet_buckets: dict[str, int] = Field(default_factory=dict)
    slot_analysis: dict = Field(default_factory=dict)

    data_quality: dict = Field(default_factory=dict)
    duration_seconds: float = 0.0
    scanned_at: int = 0
    warnings: list[str] = Field(default_factory=list)

    disclaimer_en: str = DISCLAIMER_EN
    disclaimer_fr: str = DISCLAIMER_FR

    def wallet(self, address: str) -> WalletProfile | None:
        for profile in self.wallets:
            if profile.address == address:
                return profile
        return None

    def top_cluster(self) -> Cluster | None:
        return max(self.clusters, key=lambda c: c.score, default=None)
