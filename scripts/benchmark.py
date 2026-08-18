"""Mesure le coût d'un scan en requêtes RPC.

    python -m scripts.benchmark [scenario]

Le temps réel d'un scan est dominé par le nombre de requêtes HTTP, puisque le
seau à jetons les étale. Compter les appels est donc une mesure plus stable
qu'un chronomètre : elle ne dépend ni de la latence du réseau ni de la charge
de l'endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import tempfile
from collections import Counter
from pathlib import Path

from app.cache import MemoryCache
from app.config import Settings
from app.db import dispose, init_db
from app.models.enums import ScanDepth
from app.orchestrator import ScanOrchestrator
from app.providers.base import DataQuality
from app.providers.registry import ProviderHub
from app.utils.logging import configure_logging


async def run(name: str, depth: str) -> int:
    from tests.support.rpc_server import build_client
    from tests.support.scenarios import ALL_SCENARIOS

    builder = ALL_SCENARIOS.get(name)
    if builder is None:
        print(f"Scénario inconnu : {name}. Disponibles : {', '.join(sorted(ALL_SCENARIOS))}")
        return 2

    scenario = builder()
    with tempfile.TemporaryDirectory() as tmp:
        settings = Settings(
            database_url=f"sqlite+aiosqlite:///{Path(tmp) / 'bench.db'}",
            redis_url=None,
            log_level="ERROR",
        )
        configure_logging("ERROR")
        await init_db(settings.database_url)

        quality = DataQuality()
        rpc, server = build_client(scenario.chain)
        rpc.quality = quality
        hub = ProviderHub(settings, cache=MemoryCache(), quality=quality, rpc=rpc)
        report, _ = await ScanOrchestrator(hub, settings).scan(
            scenario.mint, depth=ScanDepth(depth)
        )
        await rpc.aclose()
        await dispose()

    stats = server.summary()
    calls = Counter(stats["by_method"])
    total = stats["http_requests"]
    wallets = len(report.wallets)

    print(f"\nScénario : {scenario.name}   profondeur : {depth}")
    print("─" * 60)
    for method, count in calls.most_common():
        print(f"  {method:<28} {count:>5}")
    print("─" * 60)
    print(f"  {'appels JSON-RPC':<28} {stats['rpc_calls']:>5}")
    print(f"  {'requêtes HTTP émises':<28} {total:>5}   <- ce qui coûte du temps")
    print(f"  {'lots':<28} {stats['batches']:>5} (taille moyenne {stats['avg_batch']:.0f})")
    print(f"  {'wallets analysés':<28} {wallets:>5}")
    if wallets:
        print(f"  {'appels par wallet':<28} {total / wallets:>5.1f}")
    print()
    print("À 8 requêtes/seconde, cela représente environ "
          f"{total / 8:.0f} s de plafond réseau.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", nargs="?", default="private_bundle")
    parser.add_argument("--depth", default="full", choices=["quick", "full", "deep"])
    args = parser.parse_args(argv)
    return asyncio.run(run(args.scenario, args.depth))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
