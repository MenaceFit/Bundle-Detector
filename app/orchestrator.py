"""Scan orchestrator — the 28-step pipeline of §114.

Owns the order of work, the progress reporting and the depth profiles.  It is
the only place that knows about every stage; each stage itself stays ignorant
of the others.

Depth profiles trade breadth for latency:

=========  ==========  =========  ==========  ==================================
depth      buyers      history    creator     target
=========  ==========  =========  ==========  ==================================
quick      25          no         shallow     a few seconds
full       50          sampled    yes         ~15 seconds
deep       100         deep       full        ~30 seconds, cross-launch matching
=========  ==========  =========  ==========  ==================================

Nothing is fabricated when a stage is skipped: the corresponding coverage entry
is marked missing, which lowers the confidence score.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.analyzers import holders as holder_analysis
from app.analyzers.buyers import (
    BuyerAnalyzer,
    LaunchTape,
    purchase_distribution,
    slot_analysis,
    timeline_counts,
    transaction_order,
    window_counts,
)
from app.analyzers.creator import CreatorAnalyzer
from app.analyzers.entities import EntityClassifier
from app.analyzers.funding import FundingAnalysis, FundingAnalyzer
from app.analyzers.history import HistoryAnalysis, HistoryAnalyzer
from app.analyzers.sell_behavior import SellAnalysis, analyze_sells, post_graduation_behavior
from app.analyzers.wallet import WalletAnalyzer, apply_risk_scores, fresh_bucket_counts
from app.config import Settings, get_settings
from app.db import repository, session_scope
from app.graph.builder import GraphBuilder, GraphBundle
from app.graph.clustering import (
    ClusterEngine,
    fingerprint_cluster,
    match_recurring,
    wallet_overlap_matrix,
)
from app.models.cluster import Cluster, ClusterSignals
from app.models.enums import LifecycleState, ScanDepth
from app.models.scoring import Evidence, ScanReport
from app.models.token import TokenProfile
from app.models.wallet import CreatorProfile, WalletProfile
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun import mayhem as mayhem_module
from app.pumpfun.graduation import apply_graduation_events, read_global_initial_reserves
from app.pumpfun.lifecycle import determine_state
from app.pumpfun.token import apply_creation_event, build_token_profile
from app.pumpfun.validator import PumpFunValidator
from app.scoring import evidence as evidence_builder
from app.scoring.bundle import BundleContext
from app.scoring.risk import RiskEngine, RiskInputs
from app.utils.logging import get_logger

log = get_logger("SCAN")

ProgressCallback = Callable[[str, str], Awaitable[None]]

#: Stage keys, in pipeline order, used by the Discord progress bar (§53).
STAGES: tuple[tuple[str, str], ...] = (
    ("validate", "🔎 Validating Pump.fun token"),
    ("launch", "📊 Reading launch data"),
    ("buyers", "👛 Analyzing early buyers"),
    ("funding", "💸 Tracing funding"),
    ("graph", "🕸 Building wallet graph"),
    ("clusters", "🧠 Detecting clusters"),
    ("creator", "👨‍💻 Analyzing creator"),
    ("score", "📈 Calculating score"),
)


class NotPumpFunError(ValueError):
    """Raised when the mint is not a Pump.fun launch. The scan stops here."""

    def __init__(self, mint: str, reason: str | None) -> None:
        super().__init__(reason or "Not a Pump.fun token")
        self.mint = mint
        self.reason = reason


@dataclass
class DepthProfile:
    buyer_limit: int
    include_recent: int
    measure_age: bool
    history_wallets: int
    history_sample: int
    analyze_creator: bool
    creator_sample: int
    check_graduations: bool
    match_recurring_clusters: bool
    holder_limit: int

    @classmethod
    def for_depth(cls, depth: ScanDepth, settings: Settings) -> DepthProfile:
        if depth is ScanDepth.QUICK:
            return cls(
                buyer_limit=25,
                include_recent=0,
                measure_age=True,
                history_wallets=0,
                history_sample=0,
                analyze_creator=False,
                creator_sample=0,
                check_graduations=False,
                match_recurring_clusters=False,
                holder_limit=20,
            )
        if depth is ScanDepth.DEEP:
            return cls(
                buyer_limit=settings.first_buyers_limit,
                include_recent=200,
                measure_age=True,
                history_wallets=40,
                history_sample=150,
                analyze_creator=True,
                creator_sample=500,
                check_graduations=True,
                match_recurring_clusters=True,
                holder_limit=100,
            )
        return cls(
            buyer_limit=min(50, settings.first_buyers_limit),
            include_recent=80,
            measure_age=True,
            history_wallets=25,
            history_sample=60,
            analyze_creator=True,
            creator_sample=250,
            check_graduations=True,
            match_recurring_clusters=True,
            holder_limit=50,
        )


@dataclass
class ScanContext:
    """Intermediate state shared between stages; also returned for /graph."""

    mint: str
    depth: ScanDepth
    profile: TokenProfile | None = None
    tape: LaunchTape | None = None
    funding: FundingAnalysis | None = None
    profiles: dict[str, WalletProfile] = field(default_factory=dict)
    history: HistoryAnalysis | None = None
    creator: CreatorProfile | None = None
    graph: GraphBundle | None = None
    clusters: list[Cluster] = field(default_factory=list)
    sells: SellAnalysis | None = None
    evidence: list[Evidence] = field(default_factory=list)
    mayhem: mayhem_module.MayhemSeparation | None = None


class ScanOrchestrator:
    def __init__(self, hub: ProviderHub, settings: Settings | None = None) -> None:
        self.hub = hub
        self.settings = settings or get_settings()
        self.classifier = EntityClassifier(self.settings.scoring)
        self.risk_engine = RiskEngine(self.settings)

    async def scan(
        self,
        mint: str,
        *,
        depth: ScanDepth = ScanDepth.FULL,
        progress: ProgressCallback | None = None,
        requested_by: str | None = None,
    ) -> tuple[ScanReport, ScanContext]:
        started = time.monotonic()
        plan = DepthProfile.for_depth(depth, self.settings)
        context = ScanContext(mint=mint, depth=depth)

        async def step(stage: str, status: str = "done") -> None:
            if progress:
                await progress(stage, status)

        # 1-5: validate origin, identify creator, curve, lifecycle -----------
        await step("validate", "running")
        validation = await PumpFunValidator(self.hub).validate(mint)
        if not validation.is_pumpfun_token:
            raise NotPumpFunError(mint, validation.reason)
        await step("validate")

        # 6: launch data ------------------------------------------------------
        await step("launch", "running")
        profile = await build_token_profile(self.hub, validation, look_for_pool=True)
        context.profile = profile
        await step("launch")

        # 7-8: first buyers, holders -----------------------------------------
        await step("buyers", "running")
        tape = await BuyerAnalyzer(self.hub, self.settings.windows).build_tape(
            profile, buyer_limit=plan.buyer_limit, include_recent=plan.include_recent
        )
        context.tape = tape
        if tape.creation_event is not None:
            apply_creation_event(profile, tape.creation_event)
            for trade in tape.trades:
                if trade.block_time is not None and profile.creation_time is not None:
                    trade.seconds_after_launch = max(0.0, float(trade.block_time - profile.creation_time))
        apply_graduation_events(profile.graduation, tape.graduation_events)

        raw_holders = await self.hub.get_token_holders(mint, limit=plan.holder_limit)
        infrastructure = {a for a in (profile.bonding_curve, profile.graduation.pumpswap_pool) if a}
        holder_view = holder_analysis.analyze_holders(
            raw_holders, self.classifier, infrastructure_addresses=infrastructure
        )

        buyer_addresses = tape.first_buyers(plan.buyer_limit)
        trades_by_wallet = tape.trades_by_wallet()
        first_buys = {
            wallet: next(t for t in tape.buys if t.wallet == wallet)
            for wallet in buyer_addresses
            if any(t.wallet == wallet for t in tape.buys)
        }
        await step("buyers")

        # 9-12: funding, intermediaries, wallet age, balances -----------------
        await step("funding", "running")
        funding_analyzer = FundingAnalyzer(
            self.hub, self.classifier, max_hops=self.settings.max_funding_hops
        )
        funding = await funding_analyzer.analyze(first_buys)
        context.funding = funding

        wallet_analyzer = WalletAnalyzer(self.hub, self.classifier)
        profiles = await wallet_analyzer.profile(
            buyer_addresses,
            trades_by_wallet=trades_by_wallet,
            funding=funding,
            launch_time=profile.creation_time,
            measure_age=plan.measure_age,
        )
        context.profiles = profiles
        await step("funding")

        # 19: historical Pump.fun behaviour ----------------------------------
        history: HistoryAnalysis | None = None
        if plan.history_wallets:
            initial_reserves = await read_global_initial_reserves(self.hub)
            history_analyzer = HistoryAnalyzer(
                self.hub,
                sample_size=plan.history_sample,
                max_wallets=plan.history_wallets,
                initial_real_tokens=initial_reserves,
            )
            history = await history_analyzer.analyze(buyer_addresses, current_mint=mint)
            from app.analyzers.history import apply_history

            apply_history(profiles, history)
        else:
            self.hub.quality.set_coverage(
                "historical", CoverageLevel.MISSING, "historical analysis skipped at this scan depth"
            )
        context.history = history

        apply_risk_scores(profiles, launch_time=profile.creation_time)

        # 21: Mayhem separation ----------------------------------------------
        separation = mayhem_module.detect(tape.all_events, tape.trades, profile.mayhem)
        profile.mayhem = separation.info
        context.mayhem = separation

        # 20: creator ---------------------------------------------------------
        creator_profile: CreatorProfile | None = None
        if plan.analyze_creator and profile.creator:
            await step("creator", "running")
            creator_analyzer = CreatorAnalyzer(
                self.hub,
                self.classifier,
                funding_analyzer,
                sample_size=plan.creator_sample,
            )
            try:
                creator_profile = await creator_analyzer.analyze(
                    profile.creator,
                    current_mint=mint,
                    buyer_funding=funding,
                    max_hops=self.settings.max_funding_hops,
                    check_graduations=plan.check_graduations,
                )
            except ProviderError as exc:
                # L'analyse du créateur est la plus gourmande en requêtes, donc
                # la première à souffrir d'un endpoint saturé. Elle enrichit le
                # rapport, elle ne le conditionne pas : on continue sans.
                log.warning("creator analysis unavailable", wallet=profile.creator, error=str(exc))
                creator_profile = CreatorProfile(address=profile.creator)
                self.hub.quality.set_coverage(
                    "creator_history",
                    CoverageLevel.MISSING,
                    "analyse du créateur interrompue (fournisseur RPC indisponible)",
                )
            await step("creator")
        elif profile.creator:
            creator_profile = CreatorProfile(address=profile.creator)
            self.hub.quality.set_coverage(
                "creator_history", CoverageLevel.MISSING, "creator analysis skipped at this scan depth"
            )
        context.creator = creator_profile

        # 16-18: graphs and clusters ------------------------------------------
        await step("graph", "running")
        overlap = wallet_overlap_matrix(history, buyer_addresses) if history else {}
        graph = GraphBuilder(self.classifier).build(
            mint=mint,
            profiles=profiles,
            funding=funding,
            creator=creator_profile,
            holders=holder_view.holders[:25],
            history_overlap=overlap,
        )
        context.graph = graph
        await step("graph")

        await step("clusters", "running")
        cluster_engine = ClusterEngine(self.settings.scoring)
        clusters = cluster_engine.detect(
            graph=graph,
            profiles=profiles,
            funding=funding,
            history=history,
            creator=creator_profile,
            launch_time=profile.creation_time,
        )
        context.clusters = clusters
        self.hub.quality.clusters_detected = len(clusters)
        await step("clusters")

        # 22: sells and post-graduation behaviour -----------------------------
        top_cluster = max(clusters, key=lambda c: c.size, default=None)
        sells = analyze_sells(profiles, members=top_cluster.members if top_cluster else None)
        context.sells = sells

        # 23-25: scores, confidence, evidence ---------------------------------
        # Database access is kept strictly outside the scoring path. The
        # database is an accelerator and a memory, never a dependency: an
        # unreachable or empty one costs the cross-launch signal and nothing
        # else, and can never prevent a report from being produced.
        await step("score", "running")
        if plan.match_recurring_clusters and clusters:
            known: list = []
            async with session_scope() as session:
                known = await repository.known_cluster_fingerprints(session, exclude_mint=mint)
            for cluster in clusters:
                fingerprint = fingerprint_cluster(cluster, profiles)
                matches, similarity = match_recurring(fingerprint, known)
                cluster.recurring_launches = matches[:10]
                cluster.recurring_similarity = similarity
                cluster.signals.repeated_cluster = similarity if matches else 0.0

        for cluster in clusters:
            cluster.signals.sell_coordination = (
                sells.coordination if top_cluster and cluster.cluster_id == top_cluster.cluster_id else 0.0
            )

        report = self._finalize(
            context=context,
            plan=plan,
            holder_view=holder_view,
            sells=sells,
            started=started,
            requested_by=requested_by,
        )

        async with session_scope() as session:
            await repository.save_report(session, report)
            if plan.match_recurring_clusters:
                for cluster in clusters:
                    await repository.store_cluster_fingerprint(
                        session, mint, cluster.cluster_id, fingerprint_cluster(cluster, profiles)
                    )
        await step("score")

        log.info(
            "scan complete",
            token=mint,
            stage="done",
            bundle=report.risk.bundle.score,
            confidence=report.risk.confidence.score,
            duration=round(report.duration_seconds, 2),
        )
        return report, context

    # ------------------------------------------------------------------
    def _finalize(
        self,
        *,
        context: ScanContext,
        plan: DepthProfile,
        holder_view: holder_analysis.HolderAnalysis,
        sells: SellAnalysis,
        started: float,
        requested_by: str | None,
    ) -> ScanReport:
        profile = context.profile
        tape = context.tape
        assert profile is not None and tape is not None

        profiles = context.profiles
        clusters = context.clusters
        top_cluster = max(clusters, key=lambda c: (c.size, c.score), default=None)
        members = top_cluster.members if top_cluster else list(profiles)

        signals = top_cluster.signals if top_cluster else ClusterSignals()
        bundle_context = self._bundle_context(context, members, sells)

        risk_inputs = RiskInputs(
            cluster=top_cluster,
            signals=signals,
            profiles=profiles,
            creator=context.creator,
            quality=self.hub.quality,
            context=bundle_context,
            wallets_analyzed=len(profiles),
            history_coverage=context.history.coverage if context.history else 0.0,
            mayhem_enabled=profile.mayhem.enabled,
            mayhem_activity=context.mayhem.activity_score if context.mayhem else 0,
            sell_coordination=sells.coordination,
            same_slot_wallets=int(
                slot_analysis(tape).get("wallets_sharing_a_slot", 0) or 0
            ),
            bounded_ages=sum(1 for p in profiles.values() if p.first_seen_is_bounded),
            members=members,
        )
        risk = self.risk_engine.evaluate(risk_inputs)

        for cluster in clusters:
            cluster.confidence = risk.confidence.score
        if top_cluster is not None:
            top_cluster.score = risk.bundle.score

        evidence = evidence_builder.build(
            cluster=top_cluster,
            profiles=profiles,
            funding=context.funding or FundingAnalysis(),
            graph=context.graph,
            classifier=self.classifier,
            history=context.history,
            creator=context.creator,
            sells=sells,
            mayhem=profile.mayhem,
        )
        context.evidence = evidence

        profile.lifecycle = determine_state(
            graduation=profile.graduation,
            age_seconds=profile.age_seconds,
            trade_count=len(tape.trades),
            has_pumpswap_pool=bool(profile.graduation.pumpswap_pool),
        )

        warnings: list[str] = []
        if not tape.complete_history:
            warnings.append(
                "Trade history exceeded the page limit; the earliest buyers may be incomplete."
            )
        if profile.mayhem.enabled:
            warnings.append(mayhem_module.MAYHEM_WARNING)
        if profile.lifecycle is LifecycleState.CREATED:
            warnings.append("This coin has no trades yet; there is nothing to correlate.")

        report = ScanReport(
            mint=context.mint,
            depth=context.depth,
            token=profile,
            creator=context.creator,
            wallets=list(profiles.values()),
            first_buyers=[p.address for p in sorted(
                profiles.values(),
                key=lambda p: (p.first_buy.trade_index if p.first_buy and p.first_buy.trade_index is not None else 10**9),
            )],
            holders=holder_view.holders[:50],
            clusters=clusters,
            evidence=evidence,
            risk=risk,
            window_counts=window_counts(tape, self.settings.windows),
            timeline=timeline_counts(tape),
            fresh_wallet_buckets=fresh_bucket_counts(profiles),
            slot_analysis=slot_analysis(tape),
            data_quality=self.hub.quality.summary(),
            duration_seconds=time.monotonic() - started,
            scanned_at=int(time.time()),
            warnings=warnings,
        )
        report.data_quality["holder_concentration"] = {
            "top_1": holder_view.top_1_share,
            "top_5": holder_view.top_5_share,
            "top_10": holder_view.top_10_share,
            "gini": holder_view.gini,
            "holders_counted": holder_view.holder_count,
        }
        report.data_quality["purchase_distribution"] = purchase_distribution(tape)
        report.data_quality["transaction_order"] = transaction_order(tape)
        report.data_quality["post_graduation"] = post_graduation_behavior(
            profiles, graduation_time=profile.graduation.graduation_time
        )
        report.data_quality["requested_by"] = requested_by
        return report

    def _bundle_context(
        self, context: ScanContext, members: list[str], sells: SellAnalysis
    ) -> BundleContext:
        funding = context.funding or FundingAnalysis()
        graph = context.graph

        infra_reason: str | None = None
        funder_is_infra = False
        if graph:
            for funder, assessment in graph.infrastructure_funders.items():
                shared = [
                    m
                    for m in members
                    if (f := funding.wallets.get(m)) and f.direct_funder == funder
                ]
                if len(shared) >= 2:
                    funder_is_infra = True
                    infra_reason = assessment.reason
                    break

        fresh = [
            m
            for m in members
            if (p := context.profiles.get(m)) and p.age_seconds is not None and p.age_seconds < 3600
        ]
        unobserved = [
            m for m in members if (f := funding.wallets.get(m)) is None or not f.observed
        ]
        mayhem_share = 0.0
        if context.mayhem and context.tape and context.tape.trades:
            mayhem_share = context.mayhem.info.flagged_trades / len(context.tape.trades)

        return BundleContext(
            mayhem_share=mayhem_share,
            fresh_share=len(fresh) / len(members) if members else 0.0,
            unobserved_share=len(unobserved) / len(members) if members else 0.0,
            sell_coordination=sells.coordination,
            funder_is_infrastructure=funder_is_infra,
            infrastructure_reason=infra_reason,
        )


async def run_scan(
    mint: str,
    *,
    depth: ScanDepth = ScanDepth.FULL,
    settings: Settings | None = None,
    progress: ProgressCallback | None = None,
    cache: Any | None = None,
) -> tuple[ScanReport, ScanContext]:
    """Convenience entry point that owns provider lifecycle for one scan."""
    settings = settings or get_settings()
    async with ProviderHub(settings, cache=cache) as hub:
        return await ScanOrchestrator(hub, settings).scan(mint, depth=depth, progress=progress)
