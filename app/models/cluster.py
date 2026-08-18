"""Cluster domain models."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ClusterSignals(BaseModel):
    """Per-signal similarity of a cluster, each in ``[0, 1]``.

    These are the raw measurements.  Turning them into a score — including the
    independence requirement — is the scoring engine's job, never the
    clusterer's.
    """

    common_funder: float = 0.0
    common_intermediary: float = 0.0
    #: Payeur de frais partagé, ou achats réunis dans une même transaction.
    shared_signer: float = 0.0
    funding_amount_similarity: float = 0.0
    funding_timing_similarity: float = 0.0
    buy_amount_similarity: float = 0.0
    buy_timing_similarity: float = 0.0
    wallet_age_similarity: float = 0.0
    historical_overlap: float = 0.0
    repeated_cluster: float = 0.0
    creator_linkage: float = 0.0
    sell_coordination: float = 0.0

    def as_dict(self) -> dict[str, float]:
        return self.model_dump()

    def active(self, threshold: float = 0.35) -> list[str]:
        return [name for name, value in self.model_dump().items() if value >= threshold]


class Cluster(BaseModel):
    """A group of wallets the engine believes may share an operator."""

    cluster_id: int
    members: list[str] = Field(default_factory=list)
    method: str = "graph"
    signals: ClusterSignals = Field(default_factory=ClusterSignals)
    score: int = 0
    confidence: int = 0

    common_funders: list[str] = Field(default_factory=list)
    common_intermediaries: list[str] = Field(default_factory=list)
    #: Funders that were identified as shared infrastructure (CEX / bot service)
    #: and therefore damped rather than counted as private coordination.
    infrastructure_funders: list[str] = Field(default_factory=list)

    #: Tokens on which a materially similar member set has been seen before.
    recurring_launches: list[str] = Field(default_factory=list)
    recurring_similarity: float = 0.0

    notes: list[str] = Field(default_factory=list)

    @property
    def size(self) -> int:
        return len(self.members)


class ClusterFingerprint(BaseModel):
    """Group-level signature used to match clusters across launches (§65)."""

    size_bucket: str
    topology: str
    timing_bucket: str
    purchase_bucket: str
    age_bucket: str
    members_hash: str
    members: list[str] = Field(default_factory=list)

    def similarity(self, other: ClusterFingerprint) -> float:
        """Blend of membership overlap and structural similarity.

        Membership dominates (0.6) because a recurring *cluster* is primarily a
        recurring *set of wallets*; structure carries the rest so a group that
        rotates a few addresses but keeps its shape still matches.
        """
        from app.utils.stats import overlap_coefficient

        member_overlap = overlap_coefficient(self.members, other.members)
        structural_fields = (
            (self.size_bucket, other.size_bucket),
            (self.topology, other.topology),
            (self.timing_bucket, other.timing_bucket),
            (self.purchase_bucket, other.purchase_bucket),
            (self.age_bucket, other.age_bucket),
        )
        structural = sum(1 for a, b in structural_fields if a == b) / len(structural_fields)
        return 0.6 * member_overlap + 0.4 * structural
