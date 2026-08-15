"""Cross-launch memory tests (§33, §62, §63, §66).

The point of the database is to answer a question a single scan cannot: have
these wallets operated together before?  These tests scan two launches in
sequence and check that the second scan sees the first.
"""

from __future__ import annotations

from app.db import repository, session_scope
from app.models.enums import ScanDepth
from tests.support import scenarios
from tests.support.chain import SyntheticChain, address
from tests.support.scenarios import LAUNCH_TIME, Scenario
from tests.test_pipeline import run_scenario


def bundle_on(mint_label: str, *, funder_label: str, buyer_labels: list[str]) -> Scenario:
    """A bundled launch whose buyer set is chosen by the caller."""
    chain = SyntheticChain()
    mint = address(mint_label)
    creator = address(f"{mint_label}-creator")
    funder = address(funder_label)
    chain.unrelated_activity(wallet=creator, block_time=LAUNCH_TIME - 400_000, count=2)
    chain.create_coin(mint=mint, creator=creator, symbol="REPEAT", block_time=LAUNCH_TIME)
    buyers = []
    for i, label in enumerate(buyer_labels):
        wallet = address(label)
        chain.fund(source=funder, recipient=wallet, sol=5.0, block_time=LAUNCH_TIME - 30 + i)
        chain.buy(mint=mint, wallet=wallet, sol=1.0, block_time=LAUNCH_TIME + 3 + i, creator=creator)
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 5_000_000) for w in buyers])
    return Scenario(mint_label, chain, mint, creator, buyers)


class TestScanPersistence:
    async def test_scan_is_written_to_the_database(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings)
        async with session_scope() as session:
            stats = await repository.stats(session)
        assert stats["tokens"] >= 1
        assert stats["wallets"] >= len(report.wallets)
        assert stats["clusters"] >= 1
        assert stats["scans"] >= 1

    async def test_wallet_launch_history_is_recorded(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings)
        wallets = [w.address for w in report.wallets]
        async with session_scope() as session:
            history = await repository.wallet_launch_counts(session, wallets)
        assert history
        assert all(report.mint in mints for mints in history.values())

    async def test_creator_launches_are_recorded(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings)
        async with session_scope() as session:
            launches = await repository.creator_launch_history(session, report.token.creator)
        assert report.mint in launches

    async def test_scores_are_retrievable(self, settings):
        report, _ = await run_scenario(scenarios.private_bundle(), settings)
        async with session_scope() as session:
            scores = await repository.recent_scores(session, report.mint)
        assert scores
        assert scores[0].bundle_score == report.risk.bundle.score
        assert scores[0].classification == report.risk.classification.value


class TestRecurringClusters:
    async def test_second_launch_recognises_the_same_crew(self, settings):
        """The same wallets, funded by the same person, on a second coin."""
        crew = [f"crew-{i}" for i in range(6)]
        first = bundle_on("repeat-token-1", funder_label="repeat-funder", buyer_labels=crew)
        await run_scenario(first, settings, ScanDepth.DEEP)

        # Second launch: same crew minus one, plus a fresh address.
        second_crew = [*crew[:5], "crew-new"]
        second = bundle_on("repeat-token-2", funder_label="repeat-funder", buyer_labels=second_crew)
        report, _ = await run_scenario(second, settings, ScanDepth.DEEP)

        cluster = report.top_cluster()
        assert cluster is not None
        assert cluster.recurring_launches, "the stored fingerprint from launch 1 should match"
        assert cluster.recurring_similarity > 0.6
        assert cluster.signals.repeated_cluster > 0

    async def test_unrelated_second_launch_does_not_match(self, settings):
        first = bundle_on(
            "unrelated-1", funder_label="funder-a", buyer_labels=[f"team-a-{i}" for i in range(6)]
        )
        await run_scenario(first, settings, ScanDepth.DEEP)

        second = bundle_on(
            "unrelated-2", funder_label="funder-b", buyer_labels=[f"team-b-{i}" for i in range(6)]
        )
        report, _ = await run_scenario(second, settings, ScanDepth.DEEP)

        cluster = report.top_cluster()
        assert cluster is not None
        assert not cluster.recurring_launches
        assert cluster.signals.repeated_cluster == 0.0


class TestJobsAndWatches:
    async def test_job_lifecycle(self, settings):
        async with session_scope() as session:
            job_id = await repository.create_job(session, address("job-mint"), "full", "tester")
        assert job_id is not None
        async with session_scope() as session:
            await repository.update_job(session, job_id, status="completed", duration=1.5)
        async with session_scope() as session:
            from app.db.models import ScanJob

            job = await session.get(ScanJob, job_id)
            assert job.status == "completed"
            assert job.finished_at is not None

    async def test_watch_subscription_lifecycle(self, settings):
        mint = address("watch-mint")
        async with session_scope() as session:
            assert await repository.add_watch(session, mint, 123, "tester") is True
        async with session_scope() as session:
            assert await repository.add_watch(session, mint, 123, "tester") is False
        async with session_scope() as session:
            watches = await repository.active_watches(session)
        assert any(w.mint == mint for w in watches)
        async with session_scope() as session:
            assert await repository.stop_watch(session, mint, 123) is True
        async with session_scope() as session:
            watches = await repository.active_watches(session)
        assert not any(w.mint == mint for w in watches)


class TestDatabaseIsOptional:
    async def test_scan_completes_with_no_database(self, settings, monkeypatch):
        """Persistence is an accelerator, never a dependency."""
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def no_session():
            yield None

        monkeypatch.setattr("app.orchestrator.session_scope", no_session)
        report, _ = await run_scenario(scenarios.private_bundle(), settings, ScanDepth.DEEP)
        assert report.risk.bundle.score > 0
        assert report.evidence
