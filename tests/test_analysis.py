"""Analyzer tests: entity classification, funding tracing, clustering, sells, Mayhem."""

from __future__ import annotations

import pytest

from app.analyzers.buyers import (
    BuyerAnalyzer,
    execution_links,
    slot_analysis,
    timeline_counts,
    window_counts,
)
from app.analyzers.entities import EntityClassifier, describe_registry, lookup
from app.analyzers.funding import FundingAnalyzer
from app.analyzers.holders import analyze_holders
from app.analyzers.sell_behavior import analyze_sells
from app.analyzers.wallet import WalletAnalyzer, fresh_bucket, score_early_buyer
from app.config import AnalysisWindows, ScoringConfig
from app.graph.builder import GraphBuilder
from app.graph.clustering import ClusterEngine, fingerprint_cluster, match_recurring
from app.graph.fingerprints import build as build_fingerprint
from app.models.enums import EntityType
from app.models.wallet import TradeRecord, WalletProfile
from app.pumpfun import mayhem as mayhem_module
from app.pumpfun.constants import PUMP_FUN_PROGRAM_ID
from app.pumpfun.token import build_token_profile
from app.pumpfun.validator import PumpFunValidator
from tests.support.chain import address
from tests.support.scenarios import KNOWN_CEX, LAUNCH_TIME


class TestEntityClassification:
    def test_registry_loads_and_labels_programs(self):
        assert describe_registry()["total"] > 20
        pump = lookup(PUMP_FUN_PROGRAM_ID)
        assert pump is not None
        assert pump.entity_type is EntityType.PUMPFUN
        assert pump.source == "idl"

    def test_known_exchange_is_damped_not_counted(self):
        classifier = EntityClassifier()
        assessment = classifier.assess_funder(KNOWN_CEX)
        assert assessment.entity_type is EntityType.CEX
        assert assessment.weight < 0.5
        assert assessment.is_shared_infrastructure
        assert "exchange" in assessment.reason.lower()

    def test_program_carries_no_coordination_signal(self):
        classifier = EntityClassifier()
        assessment = classifier.assess_funder(PUMP_FUN_PROGRAM_ID)
        assert assessment.weight == 0.0

    def test_unlabelled_high_fanout_address_is_inferred_as_infrastructure(self):
        """§43 must not depend on the label list being complete."""
        classifier = EntityClassifier(ScoringConfig(infra_fanout_threshold=10))
        unknown = address("unlisted-exchange")
        for i in range(12):
            classifier.record_funding(unknown, address(f"customer-{i}"))
        assessment = classifier.assess_funder(unknown)
        assert assessment.entity_type is EntityType.INFRASTRUCTURE
        assert assessment.source == "inferred:fanout"
        assert assessment.weight < 1.0

    def test_ordinary_private_funder_is_not_damped(self):
        classifier = EntityClassifier()
        funder = address("private-funder")
        for i in range(4):
            classifier.record_funding(funder, address(f"w-{i}"))
        assessment = classifier.assess_funder(funder)
        assert assessment.entity_type is EntityType.FUNDER
        assert assessment.weight == 1.0

    def test_provider_label_text_is_interpreted(self):
        classifier = EntityClassifier()
        target = address("labelled")
        classifier.record_provider_label(target, "Binance Hot Wallet 3")
        assert classifier.classify(target).entity_type is EntityType.CEX


class TestBuyerEngine:
    async def test_tape_is_chronological_and_indexed(self, hub, chain):
        mint, creator = address("tape-mint"), address("tape-creator")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        for i in range(5):
            chain.buy(
                mint=mint,
                wallet=address(f"tape-buyer-{i}"),
                sol=1.0,
                block_time=LAUNCH_TIME + 10 * (5 - i),  # inserted out of order
                creator=creator,
            )
        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=20)

        times = [t.block_time for t in tape.trades]
        assert times == sorted(times)
        assert [t.trade_index for t in tape.trades] == list(range(len(tape.trades)))
        assert all(t.seconds_after_launch is not None for t in tape.trades)

    async def test_first_buyers_are_distinct_and_ordered(self, hub, chain):
        mint, creator = address("fb-mint"), address("fb-creator")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        first, second = address("fb-1"), address("fb-2")
        chain.buy(mint=mint, wallet=first, sol=1.0, block_time=LAUNCH_TIME + 2, creator=creator)
        chain.buy(mint=mint, wallet=second, sol=1.0, block_time=LAUNCH_TIME + 5, creator=creator)
        chain.buy(mint=mint, wallet=first, sol=2.0, block_time=LAUNCH_TIME + 9, creator=creator)

        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=20)
        assert tape.first_buyers(10) == [first, second]

    async def test_window_and_timeline_counts(self, hub, chain):
        mint, creator = address("win-mint"), address("win-creator")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        for i, delay in enumerate([2, 8, 45, 200, 2_000]):
            chain.buy(
                mint=mint,
                wallet=address(f"win-buyer-{i}"),
                sol=1.0,
                block_time=LAUNCH_TIME + delay,
                creator=creator,
            )
        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=20)

        windows = window_counts(tape, AnalysisWindows())
        assert windows["ultra_early"] == 2
        assert windows["early"] == 3
        assert windows["full"] == 5
        timeline = timeline_counts(tape)
        assert timeline["T+10s"] == 2
        assert timeline["T+60s"] == 3

    async def test_slot_analysis_reports_shared_slots_with_a_caveat(self, hub, chain):
        mint, creator = address("slot-mint"), address("slot-creator")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        shared = chain.next_slot()
        for i in range(4):
            chain.buy(
                mint=mint,
                wallet=address(f"slot-buyer-{i}"),
                sol=1.0,
                block_time=LAUNCH_TIME + 1,
                creator=creator,
                slot=shared,
            )
        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=20)

        analysis = slot_analysis(tape)
        assert analysis["wallets_sharing_a_slot"] == 4
        assert analysis["distinct_slots"] == 1
        assert "independent snipers" in analysis["caveat"]


class TestExecutionLinks:
    """§21 — liens déduits de la construction des transactions."""

    async def _tape(self, hub, mint):
        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        return await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=50)

    async def test_self_paid_buyers_produce_no_link(self, hub, chain):
        """Le cas normal : chacun paie ses propres frais. Aucun signal."""
        mint, creator = address("exec-solo-mint"), address("exec-solo-creator")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        wallets = [address(f"exec-solo-{i}") for i in range(4)]
        for i, wallet in enumerate(wallets):
            chain.buy(
                mint=mint, wallet=wallet, sol=1.0, block_time=LAUNCH_TIME + i, creator=creator
            )

        links = execution_links(await self._tape(hub, mint))
        assert links.sponsors == {}
        assert links.atomic_groups == {}
        assert links.strength_for(set(wallets)) == 0.0

    async def test_a_single_sponsored_wallet_is_not_a_link(self, hub, chain):
        """Un payeur pour un seul acheteur n'établit aucune relation entre wallets."""
        mint, creator = address("exec-one-mint"), address("exec-one-creator")
        payer = address("exec-one-payer")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        sponsored, own = address("exec-one-a"), address("exec-one-b")
        chain.buy(
            mint=mint,
            wallet=sponsored,
            sol=1.0,
            block_time=LAUNCH_TIME + 1,
            creator=creator,
            fee_payer=payer,
        )
        chain.buy(mint=mint, wallet=own, sol=1.0, block_time=LAUNCH_TIME + 2, creator=creator)

        links = execution_links(await self._tape(hub, mint))
        assert links.sponsors == {}

    async def test_shared_fee_payer_links_the_wallets_it_paid_for(self, hub, chain):
        mint, creator = address("exec-spon-mint"), address("exec-spon-creator")
        payer = address("exec-spon-payer")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        wallets = [address(f"exec-spon-{i}") for i in range(3)]
        for i, wallet in enumerate(wallets):
            chain.buy(
                mint=mint,
                wallet=wallet,
                sol=1.0,
                block_time=LAUNCH_TIME + i,
                creator=creator,
                fee_payer=payer,
            )

        links = execution_links(await self._tape(hub, mint))
        assert sorted(links.sponsors[payer]) == sorted(wallets)
        assert links.sponsored_wallets == set(wallets)
        assert links.strength_for(set(wallets)) == pytest.approx(1.0)
        # Chaque lien est traçable jusqu'à ses signatures (§60).
        assert len(links.signatures[payer]) == 3

    async def test_atomic_group_is_detected_and_weighted_above_sponsorship(self, hub, chain):
        mint, creator = address("exec-atom-mint"), address("exec-atom-creator")
        payer = address("exec-atom-payer")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        wallets = [address(f"exec-atom-{i}") for i in range(4)]
        signature = chain.atomic_buy(
            mint=mint,
            wallets=wallets,
            sol=1.0,
            block_time=LAUNCH_TIME + 1,
            creator=creator,
            fee_payer=payer,
        )

        links = execution_links(await self._tape(hub, mint))
        assert links.atomic_groups[signature] == sorted(wallets)
        assert links.atomically_grouped_wallets == set(wallets)

        size, share = links.atomic_stats_for(set(wallets))
        assert size == 4
        assert share == pytest.approx(1.0)

        # Deux membres sur quatre : l'atomicité pèse plus qu'un simple sponsor.
        half = set(wallets[:2])
        assert links.strength_for(half | {address("exec-atom-outsider"), address("x")}) > 0.5

    async def test_partial_overlap_is_measured_not_rounded_up(self, hub, chain):
        mint, creator = address("exec-part-mint"), address("exec-part-creator")
        payer = address("exec-part-payer")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        grouped = [address(f"exec-part-{i}") for i in range(2)]
        chain.atomic_buy(
            mint=mint,
            wallets=grouped,
            sol=1.0,
            block_time=LAUNCH_TIME + 1,
            creator=creator,
            fee_payer=payer,
        )
        others = [address(f"exec-part-solo-{i}") for i in range(6)]
        for i, wallet in enumerate(others):
            chain.buy(
                mint=mint, wallet=wallet, sol=1.0, block_time=LAUNCH_TIME + 5 + i, creator=creator
            )

        links = execution_links(await self._tape(hub, mint))
        size, share = links.atomic_stats_for(set(grouped) | set(others))
        assert size == 2
        assert share == pytest.approx(0.25)


class TestFundingTracer:
    async def test_direct_funder_and_delay_are_measured(self, hub, chain):
        mint, creator = address("f-mint"), address("f-creator")
        funder, buyer = address("f-funder"), address("f-buyer")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        chain.fund(source=funder, recipient=buyer, sol=5.0, block_time=LAUNCH_TIME - 30)
        chain.buy(mint=mint, wallet=buyer, sol=1.0, block_time=LAUNCH_TIME + 4, creator=creator)

        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=10)
        first_buys = {t.wallet: t for t in tape.buys}

        analyzer = FundingAnalyzer(hub, EntityClassifier())
        analysis = await analyzer.analyze(first_buys)
        record = analysis.wallets[buyer]
        assert record.direct_funder == funder
        assert record.funding_amount == pytest.approx(5.0)
        assert record.funding_to_buy_seconds == pytest.approx(34.0)
        assert record.events[0].signature

    async def test_shared_funder_groups_wallets(self, hub, chain):
        mint, creator = address("g-mint"), address("g-creator")
        funder = address("g-funder")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        wallets = [address(f"g-buyer-{i}") for i in range(4)]
        for i, wallet in enumerate(wallets):
            chain.fund(source=funder, recipient=wallet, sol=5.0, block_time=LAUNCH_TIME - 60 + i)
            chain.buy(mint=mint, wallet=wallet, sol=1.0, block_time=LAUNCH_TIME + 3 + i, creator=creator)

        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=10)
        analysis = await FundingAnalyzer(hub, EntityClassifier()).analyze({t.wallet: t for t in tape.buys})

        funder_found, members = analysis.largest_funder_group()
        assert funder_found == funder
        assert set(members) == set(wallets)

    async def test_outbound_transfers_are_not_treated_as_funding(self, hub, chain):
        """Only inflows count; spending SOL is not being funded."""
        mint, creator = address("o-mint"), address("o-creator")
        wallet = address("o-buyer")
        chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
        # The wallet *sends* SOL away before buying.
        chain.fund(source=wallet, recipient=address("o-friend"), sol=1.0, block_time=LAUNCH_TIME - 50)
        chain.buy(mint=mint, wallet=wallet, sol=1.0, block_time=LAUNCH_TIME + 4, creator=creator)

        validation = await PumpFunValidator(hub).validate(mint)
        profile = await build_token_profile(hub, validation)
        tape = await BuyerAnalyzer(hub).build_tape(profile, buyer_limit=10)
        analysis = await FundingAnalyzer(hub, EntityClassifier()).analyze({t.wallet: t for t in tape.buys})
        assert analysis.wallets[wallet].direct_funder is None


class TestWalletProfiling:
    def test_fresh_buckets(self):
        assert fresh_bucket(12) == "<30s"
        assert fresh_bucket(90) == "<5m"
        assert fresh_bucket(90_000) == ">24h"
        assert fresh_bucket(None) is None

    def test_infrastructure_wallets_are_not_risk_scored(self):
        profile = WalletProfile(address=address("x"), entity_type=EntityType.CEX, age_seconds=5)
        score, reasons = score_early_buyer(profile, launch_time=None)
        assert score == 0
        assert "not scored as a user wallet" in reasons[0]

    def test_fresh_funded_instant_buyer_scores_high(self):
        profile = WalletProfile(
            address=address("y"),
            entity_type=EntityType.BUYER,
            age_seconds=42,
            funding_to_buy_seconds=3,
            first_action_is_this_buy=True,
            first_buy=TradeRecord(
                wallet=address("y"), signature="s", slot=1, quote_amount=1.0, seconds_after_launch=2
            ),
        )
        score, reasons = score_early_buyer(profile, launch_time=None)
        assert score >= 70
        assert len(reasons) >= 3

    async def test_age_measurement_marks_bounded_results(self, hub, chain):
        wallet = address("aged-wallet")
        chain.unrelated_activity(wallet=wallet, block_time=LAUNCH_TIME - 500_000, count=5)
        analyzer = WalletAnalyzer(hub, EntityClassifier())
        profiles = await analyzer.profile(
            [wallet], trades_by_wallet={}, funding=type("F", (), {"wallets": {}})(), launch_time=None
        )
        assert profiles[wallet].first_seen is not None
        assert profiles[wallet].first_seen_is_bounded is False


class TestClustering:
    def _profiles(self, wallets, *, funder, amount=1.0, base_time=LAUNCH_TIME):
        profiles = {}
        for i, wallet in enumerate(wallets):
            profiles[wallet] = WalletProfile(
                address=wallet,
                entity_type=EntityType.BUYER,
                age_seconds=45 + i,
                funding_amount=5.0,
                funding_to_buy_seconds=3.0,
                direct_funder=funder,
                first_buy=TradeRecord(
                    wallet=wallet,
                    signature=f"sig-{wallet}",
                    slot=100 + i,
                    block_time=base_time + i,
                    quote_amount=amount,
                    seconds_after_launch=float(i + 2),
                ),
            )
        return profiles

    def _funding(self, wallets, funder):
        from app.analyzers.funding import FundingAnalysis, WalletFunding

        analysis = FundingAnalysis()
        for i, wallet in enumerate(wallets):
            analysis.wallets[wallet] = WalletFunding(
                wallet=wallet,
                direct_funder=funder,
                funding_amount=5.0,
                funding_time=LAUNCH_TIME - 40 + i,
                funding_to_buy_seconds=3.0,
                observed=True,
            )
            analysis.funder_groups.setdefault(funder, []).append(wallet)
        return analysis

    def test_shared_private_funder_produces_a_cluster(self):
        wallets = [address(f"c-{i}") for i in range(6)]
        funder = address("c-funder")
        classifier = EntityClassifier()
        funding = self._funding(wallets, funder)
        for wallet in wallets:
            classifier.record_funding(funder, wallet)
        profiles = self._profiles(wallets, funder=funder)

        graph = GraphBuilder(classifier).build(
            mint=address("c-mint"), profiles=profiles, funding=funding
        )
        clusters = ClusterEngine().detect(graph=graph, profiles=profiles, funding=funding)
        assert clusters
        assert clusters[0].size == 6
        assert clusters[0].signals.common_funder == pytest.approx(1.0)

    def test_exchange_funder_creates_no_association_edges(self):
        """The CEX case must not even reach the clusterer as a relationship."""
        wallets = [address(f"x-{i}") for i in range(6)]
        classifier = EntityClassifier()
        funding = self._funding(wallets, KNOWN_CEX)
        profiles = self._profiles(wallets, funder=KNOWN_CEX)

        graph = GraphBuilder(classifier).build(
            mint=address("x-mint"), profiles=profiles, funding=funding
        )
        assert KNOWN_CEX in graph.infrastructure_funders
        assert not graph.private_funder_groups
        assert graph.association.number_of_edges() == 0

    def test_behavioural_clustering_works_without_any_funding_link(self):
        """DBSCAN must still group wallets that behave identically.

        No shared funder means no association edge, so the graph and community
        detectors see nothing — this is the case only the behavioural detector
        can catch. It is a real finding, but with no funding topology behind it
        the score must stay moderate rather than reaching the bundle band.
        """
        from app.analyzers.funding import FundingAnalysis, WalletFunding
        from app.scoring.bundle import compute

        wallets = [address(f"beh-{i}") for i in range(6)]
        funding = FundingAnalysis()
        profiles = {}
        for i, wallet in enumerate(wallets):
            funder = address(f"beh-funder-{i}")  # a different funder each time
            funding.wallets[wallet] = WalletFunding(
                wallet=wallet,
                direct_funder=funder,
                funding_amount=5.0,
                funding_time=LAUNCH_TIME - 40 + i,
                funding_to_buy_seconds=3.0,
                observed=True,
            )
            funding.funder_groups.setdefault(funder, []).append(wallet)
            profiles[wallet] = WalletProfile(
                address=wallet,
                entity_type=EntityType.BUYER,
                age_seconds=50 + i,
                funding_amount=5.0,
                funding_to_buy_seconds=3.0,
                direct_funder=funder,
                first_buy=TradeRecord(
                    wallet=wallet,
                    signature=f"beh-sig-{i}",
                    slot=100 + i,
                    block_time=LAUNCH_TIME + i,
                    quote_amount=1.0,
                    seconds_after_launch=float(i + 2),
                ),
            )

        graph = GraphBuilder(EntityClassifier()).build(
            mint=address("beh-mint"), profiles=profiles, funding=funding
        )
        assert graph.association.number_of_edges() == 0
        clusters = ClusterEngine().detect(graph=graph, profiles=profiles, funding=funding)
        assert clusters, "behavioural clustering should still find the group"
        assert "behaviour" in clusters[0].method
        assert clusters[0].signals.common_funder == 0.0

        breakdown = compute(clusters[0].signals)
        assert breakdown.score < 60, "no funding topology means no bundle-band score"

    def test_cluster_fingerprints_match_across_launches(self):
        wallets = [address(f"r-{i}") for i in range(6)]
        funder = address("r-funder")
        classifier = EntityClassifier()
        funding = self._funding(wallets, funder)
        profiles = self._profiles(wallets, funder=funder)
        graph = GraphBuilder(classifier).build(
            mint=address("r-mint"), profiles=profiles, funding=funding
        )
        clusters = ClusterEngine().detect(graph=graph, profiles=profiles, funding=funding)
        first = fingerprint_cluster(clusters[0], profiles)

        # Same crew, one address rotated out on the next launch.
        rotated = [*wallets[:5], address("r-new")]
        funding2 = self._funding(rotated, funder)
        profiles2 = self._profiles(rotated, funder=funder)
        graph2 = GraphBuilder(EntityClassifier()).build(
            mint=address("r-mint-2"), profiles=profiles2, funding=funding2
        )
        clusters2 = ClusterEngine().detect(graph=graph2, profiles=profiles2, funding=funding2)
        second = fingerprint_cluster(clusters2[0], profiles2)

        matches, similarity = match_recurring(second, [(address("r-mint"), first)])
        assert matches
        assert similarity > 0.7

    def test_unrelated_clusters_do_not_match(self):
        wallets_a = [address(f"a-{i}") for i in range(5)]
        wallets_b = [address(f"b-{i}") for i in range(5)]
        classifier = EntityClassifier()
        fa = self._funding(wallets_a, address("fa"))
        pa = self._profiles(wallets_a, funder=address("fa"))
        ga = GraphBuilder(classifier).build(mint=address("ma"), profiles=pa, funding=fa)
        ca = ClusterEngine().detect(graph=ga, profiles=pa, funding=fa)

        fb = self._funding(wallets_b, address("fb"))
        pb = self._profiles(wallets_b, funder=address("fb"), amount=9.5)
        gb = GraphBuilder(EntityClassifier()).build(mint=address("mb"), profiles=pb, funding=fb)
        cb = ClusterEngine().detect(graph=gb, profiles=pb, funding=fb)

        matches, _ = match_recurring(
            fingerprint_cluster(cb[0], pb), [(address("ma"), fingerprint_cluster(ca[0], pa))]
        )
        assert not matches

    def test_wallet_fingerprint_similarity(self):
        profile = WalletProfile(
            address=address("fp"),
            age_seconds=40,
            funding_amount=5.0,
            pumpfun_launches=30,
            first_buy=TradeRecord(
                wallet=address("fp"), signature="s", slot=1, quote_amount=1.0, seconds_after_launch=3
            ),
        )
        twin = profile.model_copy(update={"address": address("fp2")})
        assert build_fingerprint(profile).similarity(build_fingerprint(twin)) == 1.0


class TestSellBehaviour:
    def _profile(self, name: str, *, buy_time: int, sell_time: int | None, fraction: float = 1.0):
        wallet = address(name)
        profile = WalletProfile(address=wallet, entity_type=EntityType.BUYER)
        profile.buys = [
            TradeRecord(
                wallet=wallet, signature=f"b-{name}", slot=1, block_time=buy_time, token_amount=1000.0
            )
        ]
        profile.first_buy = profile.buys[0]
        if sell_time is not None:
            profile.sells = [
                TradeRecord(
                    wallet=wallet,
                    signature=f"s-{name}",
                    slot=2,
                    block_time=sell_time,
                    is_buy=False,
                    token_amount=1000.0 * fraction,
                )
            ]
        return profile

    def test_synchronised_exits_score_high(self):
        profiles = {
            p.address: p
            for p in (
                self._profile("s1", buy_time=LAUNCH_TIME, sell_time=LAUNCH_TIME + 600),
                self._profile("s2", buy_time=LAUNCH_TIME, sell_time=LAUNCH_TIME + 605),
                self._profile("s3", buy_time=LAUNCH_TIME, sell_time=LAUNCH_TIME + 610),
            )
        }
        analysis = analyze_sells(profiles)
        assert analysis.sellers == 3
        assert analysis.coordination > 0.7
        assert analysis.synchronized_groups

    def test_scattered_exits_score_low(self):
        profiles = {
            p.address: p
            for p in (
                self._profile("d1", buy_time=LAUNCH_TIME, sell_time=LAUNCH_TIME + 600),
                self._profile("d2", buy_time=LAUNCH_TIME, sell_time=LAUNCH_TIME + 40_000),
                self._profile("d3", buy_time=LAUNCH_TIME, sell_time=LAUNCH_TIME + 90_000),
            )
        }
        assert analyze_sells(profiles).coordination < 0.2

    def test_holders_are_reported_separately(self):
        profiles = {
            p.address: p
            for p in (
                self._profile("h1", buy_time=LAUNCH_TIME, sell_time=None),
                self._profile("h2", buy_time=LAUNCH_TIME, sell_time=None),
            )
        }
        analysis = analyze_sells(profiles)
        assert analysis.holders == 2
        assert analysis.sellers == 0
        assert "No sells observed" in analysis.notes[0]


class TestMayhemSeparation:
    def _trade(self, wallet: str, *, mayhem: bool) -> TradeRecord:
        return TradeRecord(wallet=wallet, signature=f"t-{wallet}", slot=1, mayhem=mayhem)

    def test_fully_automated_wallets_are_isolated(self):
        bot, human = address("bot"), address("human")
        separation = mayhem_module.detect(
            [], [self._trade(bot, mayhem=True), self._trade(human, mayhem=False)]
        )
        assert separation.info.enabled
        assert separation.automated_wallets == {bot}
        assert [t.wallet for t in separation.human_trades] == [human]

    def test_a_wallet_trading_outside_mayhem_stays_human(self):
        wallet = address("mixed")
        trades = [self._trade(wallet, mayhem=True), self._trade(wallet, mayhem=False)]
        separation = mayhem_module.detect([], trades)
        assert wallet not in separation.automated_wallets
        assert len(separation.human_trades) == 2

    def test_activity_score_reflects_share(self):
        wallets = [address(f"m-{i}") for i in range(4)]
        trades = [self._trade(w, mayhem=True) for w in wallets[:2]]
        trades += [self._trade(w, mayhem=False) for w in wallets[2:]]
        assert mayhem_module.detect([], trades).activity_score == 50


class TestHolders:
    def test_protocol_accounts_are_excluded_from_concentration(self):
        classifier = EntityClassifier()
        curve = address("curve")
        raw = [
            {"owner": curve, "amount": 900_000},
            {"owner": address("h1"), "amount": 60_000},
            {"owner": address("h2"), "amount": 40_000},
        ]
        analysis = analyze_holders(raw, classifier, infrastructure_addresses={curve})
        assert analysis.holder_count == 2
        assert analysis.excluded[0]["owner"] == curve
        assert analysis.top_1_share == pytest.approx(0.6)
