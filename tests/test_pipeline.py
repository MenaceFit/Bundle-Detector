"""End-to-end pipeline tests against the in-memory chain.

These run the *real* orchestrator: real validation, real Borsh decoding, real
funding tracing, real clustering, real scoring.  Only the transport is
replaced.
"""

from __future__ import annotations

import pytest

from app.cache import MemoryCache
from app.models.enums import LifecycleState, PairType, ScanDepth
from app.orchestrator import NotPumpFunError, ScanOrchestrator
from app.providers.base import DataQuality
from app.providers.registry import ProviderHub
from app.pumpfun.validator import PumpFunValidator
from tests.support import scenarios
from tests.support.chain import FakeRpc, SyntheticChain, address


def build_hub(chain: SyntheticChain, settings) -> ProviderHub:
    quality = DataQuality()
    return ProviderHub(
        settings, cache=MemoryCache(), quality=quality, rpc=FakeRpc(chain, quality=quality)
    )


async def run_scenario(scenario: scenarios.Scenario, settings, depth: ScanDepth = ScanDepth.FULL):
    hub = build_hub(scenario.chain, settings)
    orchestrator = ScanOrchestrator(hub, settings)
    return await orchestrator.scan(scenario.mint, depth=depth)


class TestValidator:
    async def test_rejects_non_pumpfun_mint(self, hub):
        result = await PumpFunValidator(hub).validate(address("random-spl-token"))
        assert result.is_pumpfun_token is False
        assert result.reason

    async def test_rejects_invalid_address(self, hub):
        result = await PumpFunValidator(hub).validate("not-an-address")
        assert result.is_pumpfun_token is False
        assert result.checks["valid_address"] is False

    async def test_accepts_pumpfun_mint_and_finds_creator(self, hub, chain):
        mint, creator = address("valid-mint"), address("valid-creator")
        chain.create_coin(mint=mint, creator=creator, symbol="OK")
        result = await PumpFunValidator(hub).validate(mint)
        assert result.is_pumpfun_token is True
        assert result.creator == creator
        assert result.creation_signature
        assert result.bonding_curve

    async def test_orchestrator_raises_for_non_pumpfun(self, hub, settings):
        with pytest.raises(NotPumpFunError):
            await ScanOrchestrator(hub, settings).scan(address("not-pump"))


class TestFullReport:
    """§115: a scan must produce every required section."""

    @pytest.fixture
    async def report(self, settings):
        report, context = await run_scenario(scenarios.private_bundle(), settings)
        return report, context

    async def test_report_contains_every_required_section(self, report):
        report, context = report
        assert report.token.mint
        assert report.token.creator
        assert report.token.lifecycle in set(LifecycleState)
        assert report.token.pair is PairType.SOL
        assert report.first_buyers
        assert report.wallets
        assert report.holders
        assert report.clusters
        assert report.evidence
        assert report.window_counts and report.timeline
        assert report.fresh_wallet_buckets
        assert report.slot_analysis["buys_considered"] > 0
        assert report.data_quality["providers"]
        assert report.risk.confidence.score >= 0
        assert report.creator is not None
        assert context.graph is not None
        assert report.disclaimer_en and report.disclaimer_fr

    async def test_evidence_is_traceable_to_signatures(self, report):
        report, _ = report
        traceable = [e for e in report.evidence if e.is_traceable]
        assert traceable, "at least one finding must cite on-chain transactions"
        signatures = {s for e in traceable for s in e.signatures}
        known = set(report.wallets[0].funding_events[0].signature for _ in [0]) if report.wallets else set()
        assert signatures  # non-empty
        assert all(isinstance(s, str) and len(s) > 40 for s in signatures)
        del known

    async def test_every_evidence_item_states_its_limits(self, report):
        report, _ = report
        assert all(e.caveat for e in report.evidence)

    async def test_wallet_profiles_are_populated(self, report):
        report, _ = report
        profile = report.wallets[0]
        assert profile.first_buy is not None
        assert profile.first_buy.signature
        assert profile.direct_funder
        assert profile.funding_amount and profile.funding_amount > 0
        assert profile.funding_to_buy_seconds is not None


class TestScenarioSeparation:
    """§87 / §110 — the engine must tell these situations apart."""

    async def test_private_bundle_is_detected(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings)
        assert report.risk.bundle.score >= 60, report.risk.bundle.model_dump()
        assert report.risk.bundle.independent_signals >= 3
        cluster = report.top_cluster()
        assert cluster and cluster.size >= 6
        assert cluster.common_funders
        assert any(e.code == "COMMON_FUNDER" for e in report.evidence)

    async def test_independent_buyers_are_not_a_bundle(self, settings):
        report, _ = await run_scenario(scenarios.independent_buyers(), settings)
        assert report.risk.bundle.score < 45, report.risk.bundle.model_dump()
        assert report.risk.classification.value in {
            "NORMAL EARLY BUYERS",
            "INSUFFICIENT DATA",
            "POSSIBLE COORDINATION",
        }

    async def test_cex_funding_is_not_reported_as_a_bundle(self, settings):
        report, _ = await run_scenario(scenarios.cex_funded(), settings)
        assert report.risk.bundle.score < 60
        assert report.risk.classification.value != "BUNDLE-LIKE PATTERN"
        # The exchange must be named, and named as a weak signal.
        weak = [e for e in report.evidence if e.code == "INFRASTRUCTURE_FUNDER"]
        assert weak, "a shared exchange funder must be surfaced as a weak signal"
        assert weak[0].strength < 0.3

    async def test_identical_amounts_alone_do_not_make_a_bundle(self, settings):
        """§17: the single most important false-positive guard."""
        report, _ = await run_scenario(scenarios.identical_amounts_only(), settings)
        assert report.risk.bundle.score < 50, report.risk.bundle.model_dump()
        assert report.risk.classification.value != "BUNDLE-LIKE PATTERN"

    async def test_same_block_automation_is_labelled_as_automation(self, settings):
        report, _ = await run_scenario(scenarios.same_block_automation(), settings)
        assert report.slot_analysis["wallets_sharing_a_slot"] >= 3
        assert report.risk.classification.value in {
            "MEV / AUTOMATED ACTIVITY",
            "NORMAL EARLY BUYERS",
            "INSUFFICIENT DATA",
        }
        assert report.risk.classification.value != "BUNDLE-LIKE PATTERN"

    async def test_mayhem_activity_is_separated(self, settings):
        report, _ = await run_scenario(scenarios.mayhem_launch(), settings)
        assert report.token.mayhem.enabled
        assert report.token.mayhem.flagged_trades > 0
        assert report.risk.mayhem_activity > 0
        assert report.risk.classification.value != "BUNDLE-LIKE PATTERN"
        assert any("mayhem" in w.lower() for w in report.warnings)

    async def test_professional_snipers_are_not_bundled(self, settings):
        report, _ = await run_scenario(scenarios.professional_snipers(), settings, ScanDepth.DEEP)
        assert report.risk.classification.value != "BUNDLE-LIKE PATTERN"
        experienced = [w for w in report.wallets if (w.pumpfun_launches or 0) >= 15]
        assert experienced, "the history analyzer should see their prior launches"

    async def test_graduated_coin_is_tracked(self, settings):
        report, _ = await run_scenario(scenarios.graduated_coin(), settings)
        assert report.token.graduation.graduated is True
        assert report.token.lifecycle in {LifecycleState.GRADUATED, LifecycleState.PUMPSWAP}


class TestDepthProfiles:
    async def test_quick_scan_skips_history_and_creator_analysis(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings, ScanDepth.QUICK)
        assert report.depth is ScanDepth.QUICK
        assert report.data_quality["coverage"]["historical"] == "missing"
        # Missing coverage must be reflected in confidence, not hidden.
        assert report.risk.confidence.limitations

    async def test_deep_scan_collects_history(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings, ScanDepth.DEEP)
        assert report.data_quality["coverage"]["historical"] in {"complete", "partial"}


class TestObservability:
    async def test_counters_are_recorded(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings)
        counters = report.data_quality["counters"]
        assert counters["wallets_analyzed"] > 0
        assert counters["transactions_analyzed"] > 0
        assert report.duration_seconds > 0
