"""Scoring-engine tests (§17, §45, §46, §48, §86, §108)."""

from __future__ import annotations

import pytest

from app.config import BundleWeights, ScoringConfig
from app.models.cluster import Cluster, ClusterSignals
from app.models.enums import EntityType
from app.providers.base import CoverageLevel, DataQuality
from app.scoring import bundle as bundle_scoring
from app.scoring import confidence as confidence_engine
from app.scoring import coordination
from app.utils.stats import (
    amount_similarity,
    describe,
    gini,
    jaccard,
    overlap_coefficient,
    similarity_from_cv,
    timing_similarity,
)


class TestStatistics:
    def test_describe_handles_empty_and_single(self):
        assert describe([]).count == 0
        single = describe([4.0])
        assert single.mean == 4.0 and single.stdev == 0.0

    def test_percentiles_are_interpolated(self):
        stats = describe([1, 2, 3, 4], percentiles=(50,))
        assert stats.percentiles[50] == pytest.approx(2.5)

    def test_similarity_is_continuous_not_a_cliff(self):
        assert similarity_from_cv(0.0) == 1.0
        assert similarity_from_cv(1.0) == 0.0
        mid = similarity_from_cv(0.31)
        assert 0.0 < mid < 1.0
        # Small change in input -> small change in output.
        assert abs(similarity_from_cv(0.31) - similarity_from_cv(0.32)) < 0.1

    def test_single_sample_never_claims_perfect_similarity(self):
        """One observation carries no similarity information."""
        score, _ = amount_similarity([5.0])
        assert score == 0.0

    def test_identical_amounts_score_high(self):
        score, stats = amount_similarity([5.0, 5.01, 4.99, 5.02, 5.0])
        assert score > 0.9
        assert stats.cv < 0.01

    def test_scattered_amounts_score_low(self):
        score, _ = amount_similarity([0.1, 3.0, 12.0, 0.7, 25.0])
        assert score < 0.2

    def test_timing_similarity_respects_window(self):
        tight, _ = timing_similarity([100.0, 101.0, 102.0], window_seconds=60)
        loose, _ = timing_similarity([0.0, 30.0, 60.0], window_seconds=60)
        assert tight > 0.9
        assert loose == 0.0

    def test_set_similarity_helpers(self):
        assert jaccard({"a", "b"}, {"a", "b"}) == 1.0
        assert jaccard({"a"}, {"b"}) == 0.0
        # Overlap coefficient is robust to very different set sizes.
        assert overlap_coefficient({"a"}, {"a", "b", "c", "d"}) == 1.0

    def test_gini_measures_concentration(self):
        assert gini([1, 1, 1, 1]) == pytest.approx(0.0, abs=1e-9)
        assert gini([0, 0, 0, 100]) > 0.7


class TestIndependenceRule:
    """§46: one signal is never a bundle, no matter how strong."""

    def test_single_family_is_capped(self):
        config = ScoringConfig()
        signals = ClusterSignals(common_funder=1.0, common_intermediary=1.0)
        breakdown = bundle_scoring.compute(signals, config=config)
        assert breakdown.independent_signals == 1
        assert breakdown.score <= config.single_signal_ceiling

    def test_matching_amounts_alone_cannot_reach_high_risk(self):
        """The exact §17 case: 5 wallets, ~5 SOL each, nothing else."""
        signals = ClusterSignals(funding_amount_similarity=1.0, buy_amount_similarity=1.0)
        breakdown = bundle_scoring.compute(signals)
        assert breakdown.score < 50

    def test_full_agreement_scores_high(self):
        signals = ClusterSignals(
            common_funder=1.0,
            common_intermediary=0.9,
            shared_signer=0.9,
            funding_amount_similarity=0.97,
            funding_timing_similarity=0.95,
            buy_amount_similarity=0.93,
            buy_timing_similarity=0.96,
            wallet_age_similarity=0.88,
            historical_overlap=0.79,
            repeated_cluster=0.8,
            creator_linkage=0.6,
        )
        breakdown = bundle_scoring.compute(signals)
        assert breakdown.score >= 75, breakdown.model_dump()
        assert breakdown.independent_signals >= 4
        assert breakdown.ceiling_applied is None

    def test_weights_sum_to_one_hundred(self):
        assert BundleWeights().total() == pytest.approx(100.0)

    def test_every_point_is_attributed(self):
        signals = ClusterSignals(common_funder=1.0, buy_timing_similarity=1.0, historical_overlap=1.0)
        breakdown = bundle_scoring.compute(signals)
        attributed = sum(c.points for c in breakdown.contributions)
        assert attributed == pytest.approx(breakdown.score, abs=1.0)
        assert all(c.label for c in breakdown.contributions)

    def test_score_never_exceeds_one_hundred(self):
        signals = ClusterSignals(**{k: 1.0 for k in ClusterSignals().model_dump()})
        context = bundle_scoring.BundleContext(fresh_share=1.0, sell_coordination=1.0)
        assert bundle_scoring.compute(signals, context=context).score <= 100


class TestAtomicExecutionFloor:
    """§21 — l'atomicité est décisive, mais ne contourne pas §46."""

    @staticmethod
    def _corroborated() -> ClusterSignals:
        """Trois familles modestes : au-dessus du plafond, sous le plancher."""
        return ClusterSignals(
            common_funder=0.7,
            shared_signer=1.0,
            buy_timing_similarity=0.8,
            wallet_age_similarity=0.5,
        )

    def test_atomic_execution_raises_a_corroborated_score(self):
        signals = self._corroborated()
        plain = bundle_scoring.compute(signals)
        atomic = bundle_scoring.compute(
            signals,
            context=bundle_scoring.BundleContext(atomic_group_size=5, atomic_share=1.0),
        )
        assert plain.score < atomic.score
        assert atomic.floor_applied == ScoringConfig().atomic_execution_floor
        assert "single transaction" in (atomic.floor_reason or "")

    def test_the_floor_never_lowers_a_higher_score(self):
        signals = ClusterSignals(
            common_funder=1.0,
            shared_signer=1.0,
            funding_amount_similarity=1.0,
            funding_timing_similarity=1.0,
            buy_amount_similarity=1.0,
            buy_timing_similarity=1.0,
            wallet_age_similarity=1.0,
            historical_overlap=1.0,
            repeated_cluster=1.0,
            creator_linkage=1.0,
        )
        high = bundle_scoring.compute(signals)
        assert high.score > ScoringConfig().atomic_execution_floor
        atomic = bundle_scoring.compute(
            signals,
            context=bundle_scoring.BundleContext(atomic_group_size=5, atomic_share=1.0),
        )
        assert atomic.score == high.score
        assert atomic.floor_applied is None

    def test_atomicity_alone_cannot_defeat_the_independence_rule(self):
        """Une seule famille reste plafonnée, même atomique (§46)."""
        breakdown = bundle_scoring.compute(
            ClusterSignals(shared_signer=1.0),
            context=bundle_scoring.BundleContext(atomic_group_size=8, atomic_share=1.0),
        )
        assert breakdown.independent_signals == 1
        assert breakdown.floor_applied is None
        assert breakdown.score <= ScoringConfig().single_signal_ceiling

    def test_a_marginal_atomic_group_does_not_trigger_the_floor(self):
        """Deux wallets sur dix : la part du cluster est trop faible."""
        breakdown = bundle_scoring.compute(
            self._corroborated(),
            context=bundle_scoring.BundleContext(atomic_group_size=2, atomic_share=0.2),
        )
        assert breakdown.floor_applied is None

    def test_the_floor_is_explained_to_the_reader(self):
        breakdown = bundle_scoring.compute(
            self._corroborated(),
            context=bundle_scoring.BundleContext(atomic_group_size=5, atomic_share=1.0),
        )
        assert any("raised to" in line for line in bundle_scoring.explain(breakdown))


class TestDamping:
    def test_infrastructure_funder_is_damped_with_a_reason(self):
        signals = ClusterSignals(common_funder=1.0, common_intermediary=1.0)
        plain = bundle_scoring.compute(signals)
        damped = bundle_scoring.compute(
            signals,
            context=bundle_scoring.BundleContext(
                funder_is_infrastructure=True, infrastructure_reason="Known exchange"
            ),
        )
        assert damped.score < plain.score
        reasons = [c.damping_reason for c in damped.contributions if c.damping_reason]
        assert reasons and "exchange" in reasons[0].lower()

    def test_mayhem_share_damps_trade_pattern_signals(self):
        signals = ClusterSignals(buy_timing_similarity=1.0, buy_amount_similarity=1.0)
        clean = bundle_scoring.compute(signals)
        mayhem = bundle_scoring.compute(
            signals, context=bundle_scoring.BundleContext(mayhem_share=0.9)
        )
        assert mayhem.score < clean.score

    def test_explanation_mentions_the_ceiling(self):
        signals = ClusterSignals(common_funder=1.0)
        breakdown = bundle_scoring.compute(signals)
        breakdown.score = 90  # force the explain path
        breakdown.ceiling_applied = 35.0
        assert any("capped" in line for line in bundle_scoring.explain(breakdown))


class TestConfidence:
    @staticmethod
    def _quality(coverage: dict[str, CoverageLevel]) -> DataQuality:
        quality = DataQuality()
        for key, level in coverage.items():
            quality.set_coverage(key, level)
        health = quality.health("rpc")
        health.record(0.05, True)
        return quality

    def test_few_wallets_yields_low_confidence(self):
        report = confidence_engine.compute(
            wallets_analyzed=3,
            signals=ClusterSignals(common_funder=1.0),
            quality=self._quality({"funding": CoverageLevel.COMPLETE}),
            history_coverage=0.0,
        )
        assert report.score < 50
        assert report.limitations

    def test_many_wallets_and_full_coverage_yields_high_confidence(self):
        report = confidence_engine.compute(
            wallets_analyzed=40,
            signals=ClusterSignals(common_funder=1.0, buy_timing_similarity=0.9, historical_overlap=0.8),
            quality=self._quality(
                {
                    "funding": CoverageLevel.COMPLETE,
                    "holders": CoverageLevel.COMPLETE,
                    "historical": CoverageLevel.COMPLETE,
                    "wallet_age": CoverageLevel.COMPLETE,
                }
            ),
            history_coverage=1.0,
        )
        assert report.score >= 70
        assert report.level in {"HIGH", "MEDIUM"}

    def test_missing_coverage_lowers_confidence(self):
        full = confidence_engine.compute(
            wallets_analyzed=25,
            signals=ClusterSignals(common_funder=1.0),
            quality=self._quality({"funding": CoverageLevel.COMPLETE, "historical": CoverageLevel.COMPLETE}),
            history_coverage=1.0,
        )
        partial = confidence_engine.compute(
            wallets_analyzed=25,
            signals=ClusterSignals(common_funder=1.0),
            quality=self._quality({"funding": CoverageLevel.MISSING, "historical": CoverageLevel.MISSING}),
            history_coverage=0.0,
        )
        assert partial.score < full.score

    def test_contradictions_are_penalised_and_reported(self):
        contradictions = confidence_engine.detect_contradictions(
            signals=ClusterSignals(common_funder=0.0, buy_amount_similarity=0.9),
            infrastructure_funder=True,
            mayhem_enabled=True,
            unobserved_funding_share=0.6,
            bounded_ages=2,
        )
        assert len(contradictions) >= 4
        with_contradictions = confidence_engine.compute(
            wallets_analyzed=25,
            signals=ClusterSignals(common_funder=1.0),
            quality=self._quality({"funding": CoverageLevel.COMPLETE}),
            history_coverage=1.0,
            contradictions=contradictions,
        )
        without = confidence_engine.compute(
            wallets_analyzed=25,
            signals=ClusterSignals(common_funder=1.0),
            quality=self._quality({"funding": CoverageLevel.COMPLETE}),
            history_coverage=1.0,
        )
        assert with_contradictions.score < without.score


class TestCoordinationScores:
    def test_funding_coordination_weights_topology_highest(self):
        topology = coordination.funding_coordination(ClusterSignals(common_funder=1.0))
        pattern = coordination.funding_coordination(
            ClusterSignals(funding_amount_similarity=1.0, funding_timing_similarity=1.0)
        )
        assert topology > pattern

    def test_scores_are_bounded(self):
        signals = ClusterSignals(**{k: 1.0 for k in ClusterSignals().model_dump()})
        assert coordination.funding_coordination(signals) <= 100
        assert coordination.buy_coordination(signals) <= 100


class TestEntityTypes:
    def test_infrastructure_flag_covers_exchanges_and_programs(self):
        assert EntityType.CEX.is_infrastructure
        assert EntityType.PROGRAM.is_infrastructure
        assert EntityType.PUMPFUN.is_infrastructure
        assert not EntityType.BUYER.is_infrastructure
        assert not EntityType.FUNDER.is_infrastructure


class TestClusterModel:
    def test_active_signals_respect_threshold(self):
        signals = ClusterSignals(common_funder=0.9, buy_amount_similarity=0.1)
        assert "common_funder" in signals.active()
        assert "buy_amount_similarity" not in signals.active()

    def test_cluster_size(self):
        assert Cluster(cluster_id=1, members=["a", "b", "c"]).size == 3
