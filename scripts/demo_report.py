"""Render a full report from a regression fixture — no network, no API keys.

    python -m scripts.demo_report [scenario]

⚠️  The chain data is a **fixture**, not mainnet. This exists to show the report
format and to let you exercise the pipeline offline. Every number below is
computed by the real engine from that fixture; nothing is stubbed. For real
output, point `RPC_URL` at a mainnet endpoint and use `python -m scripts.cli`.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import tempfile
from pathlib import Path

from app.cache import MemoryCache
from app.config import Settings
from app.db import dispose, init_db
from app.models.enums import ScanDepth
from app.orchestrator import ScanOrchestrator
from app.providers.base import DataQuality
from app.providers.registry import ProviderHub
from app.utils.logging import configure_logging
from scripts.cli import render


async def run(name: str, depth: str) -> int:
    from tests.support.scenarios import ALL_SCENARIOS

    builder = ALL_SCENARIOS.get(name)
    if builder is None:
        print(f"Unknown scenario {name!r}. Available: {', '.join(sorted(ALL_SCENARIOS))}")
        return 2

    scenario = builder()
    # A throwaway file rather than ":memory:" — each aiosqlite connection gets
    # its own in-memory database, so the schema would not be visible to the
    # session that writes the report.
    with tempfile.TemporaryDirectory() as tmp:
        settings = Settings(
            database_url=f"sqlite+aiosqlite:///{Path(tmp) / 'demo.db'}",
            redis_url=None,
            discord_token=None,
            helius_api_key=None,
            solscan_api_key=None,
            log_level="WARNING",
        )
        configure_logging(settings.log_level)
        await init_db(settings.database_url)
        try:
            return await _render(scenario, settings, depth)
        finally:
            await dispose()


async def _render(scenario, settings: Settings, depth: str) -> int:
    from tests.support.chain import FakeRpc

    quality = DataQuality()
    hub = ProviderHub(
        settings, cache=MemoryCache(), quality=quality, rpc=FakeRpc(scenario.chain, quality=quality)
    )
    report, _ = await ScanOrchestrator(hub, settings).scan(scenario.mint, depth=ScanDepth(depth))

    print(f"### FIXTURE SCENARIO: {scenario.name} (expected reading: {scenario.expected or 'n/a'})")
    print("### This is synthetic chain data, not mainnet.\n")
    print(render(report))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", nargs="?", default="private_bundle")
    parser.add_argument("--depth", default="deep", choices=["quick", "full", "deep"])
    args = parser.parse_args(argv)
    return asyncio.run(run(args.scenario, args.depth))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
