"""Tests de coût réseau, sur le vrai client RPC.

Le transport est simulé, mais le client est réel : cache de signatures,
regroupement de transactions, déduplication et lots JSON-RPC sont réellement
exercés. Ces tests verrouillent les optimisations — sans eux, une régression de
performance passerait totalement inaperçue, puisque le résultat resterait juste.
"""

from __future__ import annotations

import asyncio

import pytest

from app.cache import MemoryCache
from app.models.enums import ScanDepth
from app.orchestrator import ScanOrchestrator
from app.providers.base import DataQuality
from app.providers.registry import ProviderHub
from tests.support import scenarios
from tests.support.chain import SyntheticChain, address
from tests.support.rpc_server import build_client


class TestSignatureCache:
    """Quatre étapes veulent l'historique d'un wallet ; une seule doit le payer."""

    async def test_second_request_is_served_from_cache(self, chain: SyntheticChain):
        wallet = address("cached-wallet")
        chain.unrelated_activity(wallet=wallet, block_time=1_750_000_000, count=5)
        client, server = build_client(chain)

        first = await client.get_signatures(wallet, limit=200)
        after_first = server.http_requests
        second = await client.get_signatures(wallet, limit=200)

        assert first == second
        assert server.http_requests == after_first, "aucune requête supplémentaire"
        await client.aclose()

    async def test_smaller_request_is_sliced_from_the_cached_page(self, chain: SyntheticChain):
        wallet = address("slice-wallet")
        chain.unrelated_activity(wallet=wallet, block_time=1_750_000_000, count=10)
        client, server = build_client(chain)

        await client.get_signatures(wallet, limit=200)
        after_first = server.http_requests
        small = await client.get_signatures(wallet, limit=3)

        assert len(small) == 3
        assert server.http_requests == after_first
        await client.aclose()

    async def test_before_cursor_is_served_from_the_cached_page(self, chain: SyntheticChain):
        """Le traceur de financement demande « avant tel achat » : cache aussi."""
        wallet = address("before-wallet")
        chain.unrelated_activity(wallet=wallet, block_time=1_750_000_000, count=10)
        client, server = build_client(chain)

        page = await client.get_signatures(wallet, limit=200)
        after_first = server.http_requests
        pivot = page[3]["signature"]
        tail = await client.get_signatures(wallet, limit=5, before=pivot)

        assert [e["signature"] for e in tail] == [e["signature"] for e in page[4:9]]
        assert server.http_requests == after_first
        await client.aclose()

    async def test_prefetch_uses_a_single_batched_request(self, chain: SyntheticChain):
        wallets = [address(f"pre-{i}") for i in range(12)]
        for wallet in wallets:
            chain.unrelated_activity(wallet=wallet, block_time=1_750_000_000, count=2)
        client, server = build_client(chain)

        await client.prefetch_signatures(wallets, limit=200)

        assert server.http_requests == 1, "douze wallets doivent tenir dans une requête"
        # Et tout le monde est ensuite servi sans réseau.
        before = server.http_requests
        for wallet in wallets:
            assert await client.get_signatures(wallet, limit=50)
        assert server.http_requests == before
        await client.aclose()


class TestTransactionCoalescing:
    """Des analyses parallèles ne doivent pas produire des lots minuscules."""

    async def test_concurrent_requests_share_one_batch(self, chain: SyntheticChain):
        mint, creator = address("coal-mint"), address("coal-creator")
        chain.create_coin(mint=mint, creator=creator)
        signatures = [
            chain.buy(
                mint=mint,
                wallet=address(f"coal-buyer-{i}"),
                sol=1.0,
                block_time=1_750_000_000 + i,
                creator=creator,
            )
            for i in range(20)
        ]
        client, server = build_client(chain)

        # Vingt demandeurs indépendants, comme vingt wallets analysés en parallèle.
        results = await asyncio.gather(*(client.get_transactions([s]) for s in signatures))

        assert all(list(r.values())[0] is not None for r in results)
        assert server.batch_sizes, "les demandes doivent partir groupées"
        assert max(server.batch_sizes) >= 10, (
            f"lots trop petits : {server.batch_sizes} — le regroupement ne fonctionne pas"
        )
        await client.aclose()

    async def test_duplicate_signatures_are_fetched_once(self, chain: SyntheticChain):
        mint, creator = address("dup-mint"), address("dup-creator")
        chain.create_coin(mint=mint, creator=creator)
        signature = chain.buy(
            mint=mint, wallet=address("dup-buyer"), sol=1.0, block_time=1_750_000_000, creator=creator
        )
        client, server = build_client(chain)

        await asyncio.gather(*(client.get_transactions([signature]) for _ in range(8)))

        assert server.rpc_calls["getTransaction"] == 1, "une seule récupération pour huit demandes"
        await client.aclose()


class TestWalletAgeCost:
    async def test_age_costs_a_single_page(self, chain: SyntheticChain):
        """Une page pleine suffit à conclure « ce wallet n'est pas frais »."""
        from app.analyzers.entities import EntityClassifier
        from app.analyzers.funding import FundingAnalysis
        from app.analyzers.wallet import WalletAnalyzer

        wallet = address("old-wallet")
        chain.unrelated_activity(wallet=wallet, block_time=1_700_000_000, count=50)
        client, server = build_client(chain)
        quality = DataQuality()
        client.quality = quality
        hub = ProviderHub(
            __import__("app.config", fromlist=["Settings"]).Settings(redis_url=None),
            cache=MemoryCache(),
            quality=quality,
            rpc=client,
        )

        analyzer = WalletAnalyzer(hub, EntityClassifier())
        await analyzer.profile(
            [wallet], trades_by_wallet={}, funding=FundingAnalysis(), launch_time=None
        )

        assert server.rpc_calls["getSignaturesForAddress"] <= 1
        await client.aclose()


class TestScanCost:
    """Plafond de coût par scan : une régression doit faire échouer un test."""

    @pytest.mark.parametrize(
        ("scenario_name", "depth", "budget"),
        [
            ("private_bundle", ScanDepth.QUICK, 25),
            ("private_bundle", ScanDepth.FULL, 35),
            ("independent", ScanDepth.QUICK, 55),
            ("independent", ScanDepth.FULL, 70),
        ],
    )
    async def test_scan_stays_within_its_request_budget(
        self, settings, scenario_name: str, depth: ScanDepth, budget: int
    ):
        scenario = scenarios.ALL_SCENARIOS[scenario_name]()
        client, server = build_client(scenario.chain)
        quality = DataQuality()
        client.quality = quality
        hub = ProviderHub(settings, cache=MemoryCache(), quality=quality, rpc=client)

        report, _ = await ScanOrchestrator(hub, settings).scan(scenario.mint, depth=depth)

        assert report.wallets, "le scan doit produire un vrai rapport"
        assert server.http_requests <= budget, (
            f"{scenario_name}/{depth.value} : {server.http_requests} requêtes HTTP "
            f"pour un budget de {budget}"
        )
        await client.aclose()

    async def test_real_client_produces_the_same_verdict_as_the_fake(self, settings):
        """Les optimisations ne doivent rien changer au résultat."""
        scenario = scenarios.private_bundle()
        client, _ = build_client(scenario.chain)
        quality = DataQuality()
        client.quality = quality
        hub = ProviderHub(settings, cache=MemoryCache(), quality=quality, rpc=client)

        report, _ = await ScanOrchestrator(hub, settings).scan(
            scenario.mint, depth=ScanDepth.FULL
        )

        assert report.risk.bundle.score >= 60
        assert report.risk.classification.value == "BUNDLE-LIKE PATTERN"
        cluster = report.top_cluster()
        assert cluster and cluster.size >= 6
        await client.aclose()
