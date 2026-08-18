"""Cluster detection and signal measurement (§29, §30).

Three independent detectors propose candidate groups, and the proposals are
then merged:

* **connected components** of the association graph — hard relationships
  (shared private funder, direct transfer);
* **community detection** (Louvain) on the weighted association graph — finds
  tightly-knit sub-groups inside one large component, which is what separates
  two different bundlers who happen to share an upstream hop;
* **DBSCAN** over behavioural features (entry time, entry size, funding size,
  funding delay, wallet age) — finds wallets that behave identically even when
  no direct funding relationship is visible.

Using three is not redundancy for its own sake.  Each has a characteristic
blind spot: components over-merge, communities need edges to exist at all, and
DBSCAN happily groups strangers who merely bought a round number at the same
moment.  A group proposed by more than one method is materially more credible,
and that agreement is recorded on the cluster so the scorer can use it.

This module *measures*; it never decides.  Turning measurements into a bundle
score — including the requirement that several independent signals agree — is
``app.scoring.bundle``'s job.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Any

import networkx as nx

from app.analyzers.funding import FundingAnalysis
from app.analyzers.history import HistoryAnalysis
from app.config import ScoringConfig
from app.graph.builder import GraphBundle
from app.models.cluster import Cluster, ClusterFingerprint, ClusterSignals
from app.models.wallet import CreatorProfile, WalletProfile
from app.utils.logging import get_logger
from app.utils.stats import amount_similarity, jaccard, overlap_coefficient, timing_similarity

log = get_logger("CLUSTER")

#: Two candidate groups are merged when their Jaccard similarity reaches this.
MERGE_THRESHOLD = 0.5
#: DBSCAN parameters over standardized behavioural features.
DBSCAN_EPS = 0.75
DBSCAN_MIN_SAMPLES = 3
#: Window used when judging how tightly a cluster's buys are grouped.
BUY_TIMING_WINDOW = 60.0
#: Window used for funding synchronisation (§15).
FUNDING_TIMING_WINDOW = 300.0


@dataclass
class CandidateGroup:
    members: frozenset[str]
    methods: set[str] = field(default_factory=set)


class ClusterEngine:
    def __init__(self, config: ScoringConfig | None = None) -> None:
        self.config = config or ScoringConfig()

    # ------------------------------------------------------------------
    def detect(
        self,
        *,
        graph: GraphBundle,
        profiles: dict[str, WalletProfile],
        funding: FundingAnalysis,
        history: HistoryAnalysis | None = None,
        creator: CreatorProfile | None = None,
        launch_time: int | None = None,
        execution: Any | None = None,
    ) -> list[Cluster]:
        candidates = self._candidates(graph, profiles, execution=execution)
        clusters: list[Cluster] = []

        for index, candidate in enumerate(sorted(candidates, key=lambda c: -len(c.members)), start=1):
            members = sorted(candidate.members)
            if len(members) < self.config.min_cluster_size:
                continue
            cluster = Cluster(
                cluster_id=index,
                members=members,
                method="+".join(sorted(candidate.methods)),
            )
            cluster.signals = self.measure(
                members,
                profiles=profiles,
                funding=funding,
                history=history,
                creator=creator,
                graph=graph,
                execution=execution,
            )
            cluster.common_funders = sorted(
                {
                    funder
                    for funder, wallets in graph.private_funder_groups.items()
                    if len(set(wallets) & candidate.members) >= 2
                }
            )
            cluster.common_intermediaries = sorted(
                {
                    hop
                    for hop, wallets in graph.intermediary_groups.items()
                    if len(set(wallets) & candidate.members) >= 2
                }
            )
            cluster.infrastructure_funders = sorted(
                {
                    funder
                    for funder, assessment in graph.infrastructure_funders.items()
                    if any(
                        profiles.get(m) and profiles[m].direct_funder == funder for m in members
                    )
                    and assessment is not None
                }
            )
            if len(candidate.methods) > 1:
                cluster.notes.append(
                    "Independently proposed by " + " and ".join(sorted(candidate.methods))
                )
            clusters.append(cluster)

        for cluster in clusters:
            for member in cluster.members:
                profile = profiles.get(member)
                if profile is not None:
                    profile.cluster_id = cluster.cluster_id

        log.info("clusters detected", count=len(clusters))
        return clusters

    # ------------------------------------------------------------------
    def _candidates(
        self,
        graph: GraphBundle,
        profiles: dict[str, WalletProfile],
        *,
        execution: Any | None = None,
    ) -> list[CandidateGroup]:
        groups: list[CandidateGroup] = []

        for component in nx.connected_components(graph.association):
            if len(component) >= 2:
                groups.append(CandidateGroup(members=frozenset(component), methods={"graph"}))

        # Un signataire partagé ou une transaction commune forment un groupe à
        # eux seuls : ce sont des liens structurels, pas des ressemblances.
        if execution is not None:
            for wallets in list(execution.sponsors.values()) + list(execution.atomic_groups.values()):
                known = frozenset(w for w in wallets if w in profiles)
                if len(known) >= 2:
                    groups.append(CandidateGroup(members=known, methods={"execution"}))

        for community in self._communities(graph.association):
            if len(community) >= 2:
                groups.append(CandidateGroup(members=frozenset(community), methods={"community"}))

        for behavioural in self._behavioural_groups(profiles):
            if len(behavioural) >= 2:
                groups.append(CandidateGroup(members=frozenset(behavioural), methods={"behaviour"}))

        return self._merge(groups)

    @staticmethod
    def _communities(association: nx.Graph) -> list[set[str]]:
        if association.number_of_edges() == 0:
            return []
        try:
            return [set(c) for c in nx.community.louvain_communities(association, weight="weight", seed=7)]
        except Exception as exc:  # noqa: BLE001 - algorithm availability varies
            log.debug("louvain unavailable", error=str(exc))
            try:
                return [
                    set(c)
                    for c in nx.community.greedy_modularity_communities(association, weight="weight")
                ]
            except Exception:  # noqa: BLE001 - graph too small / disconnected
                return []

    def _behavioural_groups(self, profiles: dict[str, WalletProfile]) -> list[set[str]]:
        """DBSCAN over standardized behavioural features."""
        rows: list[list[float]] = []
        addresses: list[str] = []
        for address, profile in profiles.items():
            vector = _feature_vector(profile)
            if vector is None:
                continue
            addresses.append(address)
            rows.append(vector)

        if len(rows) < DBSCAN_MIN_SAMPLES:
            return []
        try:
            import numpy as np
            from sklearn.cluster import DBSCAN
            from sklearn.preprocessing import StandardScaler
        except ImportError:  # pragma: no cover - optional dependency
            return []

        matrix = StandardScaler().fit_transform(np.asarray(rows, dtype=float))
        labels = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES).fit_predict(matrix)
        grouped: dict[int, set[str]] = {}
        for address, label in zip(addresses, labels, strict=False):
            if label < 0:  # noise
                continue
            grouped.setdefault(int(label), set()).add(address)
        return list(grouped.values())

    @staticmethod
    def _merge(groups: list[CandidateGroup]) -> list[CandidateGroup]:
        """Merge overlapping proposals, remembering which methods agreed."""
        merged: list[CandidateGroup] = []
        for group in sorted(groups, key=lambda g: -len(g.members)):
            for existing in merged:
                if jaccard(group.members, existing.members) >= MERGE_THRESHOLD:
                    existing.members = frozenset(existing.members | group.members)
                    existing.methods |= group.methods
                    break
                if group.members <= existing.members:
                    existing.methods |= group.methods
                    break
            else:
                merged.append(CandidateGroup(members=group.members, methods=set(group.methods)))
        return merged

    # ------------------------------------------------------------------
    def measure(
        self,
        members: list[str],
        *,
        profiles: dict[str, WalletProfile],
        funding: FundingAnalysis,
        history: HistoryAnalysis | None,
        creator: CreatorProfile | None,
        graph: GraphBundle,
        execution: Any | None = None,
    ) -> ClusterSignals:
        """Measure every cluster signal. Pure measurement, no weighting."""
        signals = ClusterSignals()
        member_set = set(members)
        member_profiles = [profiles[m] for m in members if m in profiles]
        if not member_profiles:
            return signals

        # --- funder topology --------------------------------------------
        # A source only counts as "common" when it reaches at least two members
        # of this cluster. Every wallet has *some* funder; one funder per wallet
        # is the null hypothesis, not a coordination signal, and counting it
        # would give every cluster a floor of 1/size on this signal.
        signals.common_funder = _best_shared_share(graph.private_funder_groups, member_set)
        signals.common_intermediary = _best_shared_share(graph.intermediary_groups, member_set)
        if execution is not None:
            signals.shared_signer = execution.strength_for(member_set)

        # --- amounts and timing -----------------------------------------
        funding_amounts = [
            f.funding_amount
            for m in members
            if (f := funding.wallets.get(m)) and f.funding_amount
        ]
        signals.funding_amount_similarity, _ = amount_similarity(
            funding_amounts,
            cv_identical=self.config.cv_identical,
            cv_unrelated=self.config.cv_unrelated,
        )

        funding_times = [
            float(f.funding_time)
            for m in members
            if (f := funding.wallets.get(m)) and f.funding_time
        ]
        signals.funding_timing_similarity, _ = timing_similarity(
            funding_times, window_seconds=FUNDING_TIMING_WINDOW
        )

        buy_amounts = [p.first_buy.quote_amount for p in member_profiles if p.first_buy]
        signals.buy_amount_similarity, _ = amount_similarity(
            [a for a in buy_amounts if a > 0],
            cv_identical=self.config.cv_identical,
            cv_unrelated=self.config.cv_unrelated,
        )

        buy_times = [
            float(p.first_buy.block_time)
            for p in member_profiles
            if p.first_buy and p.first_buy.block_time
        ]
        signals.buy_timing_similarity, _ = timing_similarity(
            buy_times, window_seconds=BUY_TIMING_WINDOW
        )

        ages = [p.age_seconds for p in member_profiles if p.age_seconds is not None]
        signals.wallet_age_similarity, _ = amount_similarity(
            ages, cv_identical=0.05, cv_unrelated=1.0
        )

        # --- history -----------------------------------------------------
        if history:
            overlaps: list[float] = []
            for i, a in enumerate(members):
                for b in members[i + 1 :]:
                    overlaps.append(history.co_occurrence(a, b))
            if overlaps:
                signals.historical_overlap = sum(overlaps) / len(overlaps)

        # --- creator linkage ---------------------------------------------
        if creator and creator.linked_buyers:
            linked = len(set(creator.linked_buyers) & member_set)
            signals.creator_linkage = linked / len(member_set)

        return signals


def _best_shared_share(groups: dict[str, list[str]], members: set[str]) -> float:
    """Largest share of ``members`` reached by any single source.

    Sources touching fewer than two members are ignored: sharing a source with
    nobody is not sharing.
    """
    if not members:
        return 0.0
    best = 0.0
    for wallets in groups.values():
        overlap = len(set(wallets) & members)
        if overlap < 2:
            continue
        best = max(best, overlap / len(members))
    return best


def _feature_vector(profile: WalletProfile) -> list[float] | None:
    """Behavioural feature vector, or ``None`` when too little is known.

    Log scaling is used throughout: the difference between 0.1 and 1 SOL is
    behaviourally larger than between 10 and 11 SOL, and a linear scale would
    let a single whale dominate the clustering.
    """
    if profile.first_buy is None:
        return None
    entry_delay = profile.first_buy.seconds_after_launch
    if entry_delay is None:
        return None
    return [
        math.log10(1.0 + entry_delay),
        math.log10(1.0 + max(0.0, profile.first_buy.quote_amount)),
        math.log10(1.0 + max(0.0, profile.funding_amount or 0.0)),
        math.log10(1.0 + max(0.0, profile.funding_to_buy_seconds or 0.0)),
        math.log10(1.0 + max(0.0, profile.age_seconds if profile.age_seconds is not None else 86_400.0)),
    ]


# ---------------------------------------------------------------------------
# Recurring clusters across launches (§33, §66)
# ---------------------------------------------------------------------------
def fingerprint_cluster(cluster: Cluster, profiles: dict[str, WalletProfile]) -> ClusterFingerprint:
    members = sorted(cluster.members)
    digest = hashlib.sha256("|".join(members).encode("utf-8")).hexdigest()[:16]
    signals = cluster.signals
    return ClusterFingerprint(
        size_bucket=_bucket_size(len(members)),
        topology=_topology(cluster),
        timing_bucket=_bucket_ratio(signals.buy_timing_similarity),
        purchase_bucket=_bucket_ratio(signals.buy_amount_similarity),
        age_bucket=_bucket_ratio(signals.wallet_age_similarity),
        members_hash=digest,
        members=members,
    )


def match_recurring(
    fingerprint: ClusterFingerprint, known: list[tuple[str, ClusterFingerprint]], *, threshold: float = 0.6
) -> tuple[list[str], float]:
    """Find previously-seen clusters similar to this one.

    Returns the matching tokens and the best similarity found.
    """
    matches: list[tuple[str, float]] = []
    for mint, other in known:
        similarity = fingerprint.similarity(other)
        if similarity >= threshold:
            matches.append((mint, similarity))
    matches.sort(key=lambda item: item[1], reverse=True)
    best = matches[0][1] if matches else 0.0
    return [mint for mint, _ in matches], best


def wallet_overlap_matrix(history: HistoryAnalysis, wallets: list[str]) -> dict[tuple[str, str], float]:
    """Pairwise historical launch overlap, used as a graph edge weight (§34)."""
    matrix: dict[tuple[str, str], float] = {}
    for i, a in enumerate(wallets):
        ha = history.wallets.get(a)
        if not ha or not ha.launches:
            continue
        for b in wallets[i + 1 :]:
            hb = history.wallets.get(b)
            if not hb or not hb.launches:
                continue
            overlap = overlap_coefficient(ha.launches, hb.launches)
            if overlap > 0:
                matrix[(a, b)] = overlap
    return matrix


def _bucket_size(size: int) -> str:
    if size <= 3:
        return "small"
    if size <= 7:
        return "medium"
    if size <= 15:
        return "large"
    return "very_large"


def _bucket_ratio(value: float) -> str:
    if value >= 0.85:
        return "very_high"
    if value >= 0.6:
        return "high"
    if value >= 0.35:
        return "medium"
    return "low"


def _topology(cluster: Cluster) -> str:
    if cluster.common_funders and cluster.common_intermediaries:
        return "funder+intermediary"
    if cluster.common_funders:
        return "single_funder"
    if cluster.common_intermediaries:
        return "intermediary"
    return "behavioural"
