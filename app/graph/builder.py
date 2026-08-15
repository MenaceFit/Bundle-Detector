"""Wallet and funding graph construction (§25, §26).

Two graphs are produced from the same data:

``full``
    A directed multigraph of everything observed — creator, funders,
    intermediaries, buyers, sellers, holders — with typed edges.  This is what
    the bubble map renders and what evidence is traced through.

``association``
    An undirected, weighted projection where an edge means "these two wallets
    look related, and here is how strongly".  This is what the clusterer runs
    on.  Infrastructure is excluded from it by construction: a CEX that funded
    forty wallets creates no association edges at all, because it associates
    nobody with anybody.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx

from app.analyzers.entities import EntityClassifier, FunderAssessment
from app.analyzers.funding import FundingAnalysis
from app.models.enums import EntityType, RelationType
from app.models.wallet import CreatorProfile, WalletProfile
from app.utils.logging import get_logger

log = get_logger("CLUSTER")

#: Association weight contributed by each kind of shared relationship.
WEIGHT_SHARED_FUNDER = 1.0
WEIGHT_SHARED_INTERMEDIARY = 0.6
WEIGHT_DIRECT_TRANSFER = 1.0
WEIGHT_SHARED_LAUNCH_HISTORY = 0.5


@dataclass
class GraphBundle:
    full: nx.MultiDiGraph
    association: nx.Graph
    #: Funders judged to be shared infrastructure, with the reasoning.
    infrastructure_funders: dict[str, FunderAssessment] = field(default_factory=dict)
    #: Non-infrastructure funder -> wallets it funded in this scan.
    private_funder_groups: dict[str, list[str]] = field(default_factory=dict)
    intermediary_groups: dict[str, list[str]] = field(default_factory=dict)

    def wallet_nodes(self) -> list[str]:
        return [n for n, d in self.full.nodes(data=True) if d.get("role") == "wallet"]


class GraphBuilder:
    def __init__(self, classifier: EntityClassifier) -> None:
        self.classifier = classifier

    def build(
        self,
        *,
        mint: str,
        profiles: dict[str, WalletProfile],
        funding: FundingAnalysis,
        creator: CreatorProfile | None = None,
        holders: list[dict] | None = None,
        history_overlap: dict[tuple[str, str], float] | None = None,
    ) -> GraphBundle:
        full = nx.MultiDiGraph()
        association = nx.Graph()
        bundle = GraphBundle(full=full, association=association)

        full.add_node(mint, role="token", entity_type="TOKEN", label=mint)

        for address, profile in profiles.items():
            full.add_node(
                address,
                role="wallet",
                entity_type=profile.entity_type.value,
                label=profile.label,
                sol_balance=profile.sol_balance or 0.0,
                position=profile.token_position,
                age_seconds=profile.age_seconds,
                risk=profile.risk_score,
                cluster=None,
            )
            association.add_node(address)
            for trade in profile.buys:
                full.add_edge(
                    address,
                    mint,
                    key=f"buy:{trade.signature}",
                    relation=RelationType.BOUGHT.value,
                    amount=trade.quote_amount,
                    signature=trade.signature,
                    block_time=trade.block_time,
                )
            for trade in profile.sells:
                full.add_edge(
                    address,
                    mint,
                    key=f"sell:{trade.signature}",
                    relation=RelationType.SOLD.value,
                    amount=trade.quote_amount,
                    signature=trade.signature,
                    block_time=trade.block_time,
                )

        if creator:
            full.add_node(
                creator.address,
                role="wallet",
                entity_type=EntityType.CREATOR.value,
                label="creator",
                risk=creator.risk_score,
            )
            full.add_edge(
                creator.address, mint, key="created", relation=RelationType.CREATED.value
            )
            if creator.funding_source:
                self._add_funding_edge(
                    full, creator.funding_source, creator.address, amount=creator.funding_amount, signature=None
                )

        # --- funding edges -------------------------------------------------
        for wallet, wallet_funding in funding.wallets.items():
            for event in wallet_funding.events[:3]:
                if not event.source:
                    continue
                self._ensure_actor(full, event.source)
                self._add_funding_edge(
                    full, event.source, wallet, amount=event.amount, signature=event.signature
                )
            path = wallet_funding.path.path if wallet_funding.path else []
            for upstream, downstream in zip(path, path[1:], strict=False):
                if upstream == downstream:
                    continue
                self._ensure_actor(full, upstream)
                self._ensure_actor(full, downstream)
                if not full.has_edge(upstream, downstream):
                    self._add_funding_edge(full, upstream, downstream, amount=None, signature=None)

        # --- association edges ---------------------------------------------
        for funder, wallets in funding.funder_groups.items():
            assessment = self.classifier.assess_funder(funder)
            if assessment.is_shared_infrastructure:
                bundle.infrastructure_funders[funder] = assessment
                self._ensure_actor(full, funder, entity_type=assessment.entity_type)
                continue
            bundle.private_funder_groups[funder] = sorted(set(wallets))
            self._link_group(
                association,
                wallets,
                weight=WEIGHT_SHARED_FUNDER * assessment.weight,
                relation=RelationType.COMMON_FUNDER.value,
                via=funder,
            )

        for intermediary, wallets in funding.intermediary_groups.items():
            if intermediary in funding.funder_groups:
                continue
            assessment = self.classifier.assess_funder(intermediary)
            if assessment.is_shared_infrastructure:
                bundle.infrastructure_funders.setdefault(intermediary, assessment)
                continue
            unique = sorted(set(wallets))
            if len(unique) < 2:
                continue
            bundle.intermediary_groups[intermediary] = unique
            self._link_group(
                association,
                unique,
                weight=WEIGHT_SHARED_INTERMEDIARY * assessment.weight,
                relation=RelationType.COMMON_INTERMEDIARY.value,
                via=intermediary,
            )

        # Direct wallet-to-wallet transfers are the strongest association there is.
        for wallet, wallet_funding in funding.wallets.items():
            source = wallet_funding.direct_funder
            if source and source in profiles and source != wallet:
                self._add_association(
                    association,
                    source,
                    wallet,
                    weight=WEIGHT_DIRECT_TRANSFER,
                    relation=RelationType.FUNDED.value,
                    via=source,
                )

        for (a, b), overlap in (history_overlap or {}).items():
            if overlap <= 0 or a == b:
                continue
            self._add_association(
                association,
                a,
                b,
                weight=WEIGHT_SHARED_LAUNCH_HISTORY * overlap,
                relation=RelationType.COMMON_LAUNCH.value,
                via="history",
            )

        for holder in holders or []:
            owner = holder.get("owner")
            if not owner or owner in profiles:
                continue
            full.add_node(
                owner,
                role="holder",
                entity_type=EntityType.UNKNOWN.value,
                label=holder.get("label"),
                position=float(holder.get("amount") or 0),
            )
            full.add_edge(owner, mint, key=f"holds:{owner}", relation="HOLDS")

        log.info(
            "graph built",
            nodes=full.number_of_nodes(),
            edges=full.number_of_edges(),
            associations=association.number_of_edges(),
            infra_funders=len(bundle.infrastructure_funders),
        )
        return bundle

    # ------------------------------------------------------------------
    def _ensure_actor(self, graph: nx.MultiDiGraph, address: str, entity_type: EntityType | None = None) -> None:
        if graph.has_node(address):
            return
        label = self.classifier.classify(address, default=entity_type or EntityType.FUNDER)
        graph.add_node(
            address,
            role="actor",
            entity_type=(entity_type or label.entity_type).value,
            label=label.label,
        )

    @staticmethod
    def _add_funding_edge(
        graph: nx.MultiDiGraph, source: str, target: str, *, amount: float | None, signature: str | None
    ) -> None:
        graph.add_edge(
            source,
            target,
            key=f"fund:{signature or target}",
            relation=RelationType.FUNDED.value,
            amount=amount,
            signature=signature,
        )

    @staticmethod
    def _add_association(
        graph: nx.Graph, a: str, b: str, *, weight: float, relation: str, via: str
    ) -> None:
        if a == b or weight <= 0:
            return
        if graph.has_edge(a, b):
            data = graph[a][b]
            data["weight"] = data.get("weight", 0.0) + weight
            data.setdefault("relations", []).append(relation)
            data.setdefault("via", []).append(via)
        else:
            graph.add_edge(a, b, weight=weight, relations=[relation], via=[via])

    def _link_group(
        self, graph: nx.Graph, wallets: list[str], *, weight: float, relation: str, via: str
    ) -> None:
        unique = sorted(set(wallets))
        if len(unique) < 2 or weight <= 0:
            return
        # A shared attribute links every pair in the group, but the per-pair
        # weight is divided by group size so a very large group does not
        # accumulate unbounded association strength from one relationship.
        scaled = weight / max(1.0, (len(unique) - 1) ** 0.5)
        for i, a in enumerate(unique):
            for b in unique[i + 1 :]:
                self._add_association(graph, a, b, weight=scaled, relation=relation, via=via)
