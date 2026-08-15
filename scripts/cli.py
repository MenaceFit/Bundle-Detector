"""Terminal scanner.

Renders the same report the Discord bot produces, in the same order — evidence
first, verdict last — so a scan can be verified without a Discord token.

    python -m scripts.cli <MINT> --depth deep --export
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.cache import build_cache
from app.config import get_settings
from app.db import init_db
from app.export import export_all
from app.models.enums import ScanDepth
from app.models.scoring import ScanReport
from app.orchestrator import NotPumpFunError, ScanOrchestrator
from app.providers.registry import ProviderHub
from app.scoring.bundle import explain
from app.scoring.risk import verdict_lines
from app.utils.addresses import is_valid_pubkey, shorten
from app.utils.logging import configure_logging
from app.utils.timefmt import human_duration

BAR = "─" * 68


def render(report: ScanReport) -> str:
    token = report.token
    risk = report.risk
    out: list[str] = []

    out.append(BAR)
    out.append(f"🚨 PUMP.FUN TOKEN ANALYSIS   {token.display_symbol}  {token.name or ''}")
    out.append(f"Mint:   {token.mint}")
    out.append(f"Launch: {human_duration(token.age_seconds)} ago")
    out.append(f"Status: {token.lifecycle.label}   Pair: {token.pair.value}   Mayhem: {'YES' if token.mayhem.enabled else 'NO'}")
    if token.graduation.progress is not None and not token.graduation.graduated:
        out.append(f"Graduation: {token.graduation.progress * 100:.1f}% complete")
    if token.graduation.pumpswap_pool:
        out.append(f"PumpSwap pool: {token.graduation.pumpswap_pool}")
    out.append(BAR)

    out.append("EVIDENCE")
    if not report.evidence:
        out.append("  No coordination evidence found in the retrievable data.")
    for index, item in enumerate(report.evidence[:8], start=1):
        out.append(f"  #{index} {item.title}")
        out.append(f"     {item.detail}")
        if item.wallets:
            out.append("     wallets: " + ", ".join(shorten(w) for w in item.wallets[:8]))
        if item.signatures:
            out.append("     txs:     " + ", ".join(shorten(s, 6, 6) for s in item.signatures[:5]))
        else:
            out.append("     txs:     (no direct transaction reference)")
        if item.caveat:
            out.append(f"     caveat:  {item.caveat}")
    out.append(BAR)

    cluster = report.top_cluster()
    out.append("CLUSTER")
    if cluster is None:
        out.append("  No cluster met the minimum size.")
    else:
        signals = cluster.signals
        out.append(f"  {cluster.size} wallets · detected by {cluster.method} · score {cluster.score}/100")
        out.append(f"  common funder:        {'YES' if cluster.common_funders else 'NO'}")
        out.append(f"  common intermediary:  {'YES' if cluster.common_intermediaries else 'NO'}")
        out.append(f"  funding similarity:   {signals.funding_amount_similarity * 100:.0f}%")
        out.append(f"  funding timing:       {signals.funding_timing_similarity * 100:.0f}%")
        out.append(f"  purchase timing:      {signals.buy_timing_similarity * 100:.0f}%")
        out.append(f"  buy amount similarity:{signals.buy_amount_similarity * 100:.0f}%")
        out.append(f"  wallet age similarity:{signals.wallet_age_similarity * 100:.0f}%")
        out.append(f"  historical overlap:   {signals.historical_overlap * 100:.0f}%")
        if cluster.recurring_launches:
            out.append(f"  repeated cluster:     {cluster.recurring_similarity * 100:.0f}% on {len(cluster.recurring_launches)} prior launch(es)")
        if cluster.infrastructure_funders:
            out.append(f"  damped funders:       {', '.join(shorten(f) for f in cluster.infrastructure_funders)}")
    out.append(BAR)

    if report.creator:
        creator = report.creator
        out.append("CREATOR")
        out.append(f"  {creator.address}")
        out.append(f"  Pump.fun launches: {creator.launches_total}   graduated: {creator.launches_graduated}   abandoned: {creator.launches_abandoned}")
        out.append(f"  funding source:    {creator.funding_source or 'not observed'}")
        out.append(f"  linked buyers:     {len(creator.linked_buyers)}")
        out.append(f"  creator risk:      {creator.risk_score}/100")
        for reason in creator.risk_reasons[:4]:
            out.append(f"    • {reason}")
        out.append(BAR)

    out.append("SCORES")
    out.append(f"  Bundle                {risk.bundle.score:>3}/100")
    out.append(f"  Funding coordination  {risk.funding_coordination:>3}/100")
    out.append(f"  Buy coordination      {risk.buy_coordination:>3}/100")
    out.append(f"  Wallet cluster        {risk.wallet_cluster:>3}/100")
    out.append(f"  Creator link          {risk.creator_link:>3}/100")
    out.append(f"  Historical pattern    {risk.historical_pattern:>3}/100")
    out.append(f"  Sell coordination     {risk.sell_coordination:>3}/100")
    out.append(f"  Mayhem activity       {risk.mayhem_activity:>3}/100")
    out.append(f"  Early buyer risk      {risk.early_buyer_risk:>3}/100")
    out.append(f"  Dev risk              {risk.dev_risk:>3}/100")
    out.append(f"  Overall               {risk.overall_risk:>3}/100")
    out.append(f"  Confidence            {risk.confidence.score:>3}%  ({risk.confidence.level})")
    out.append("")
    out.append("  Contributors:")
    for line in explain(risk.bundle):
        out.append(f"    {line}")
    out.append(BAR)

    quality = report.data_quality
    out.append(f"DATA QUALITY: {quality.get('score', 0) * 100:.0f}%")
    for name, info in (quality.get("providers") or {}).items():
        icon = {"ok": "✅", "degraded": "⚠️", "failed": "❌", "disabled": "➖"}.get(info["status"], "?")
        out.append(f"  {icon} {name:<22} {info['requests']} req  {info['avg_latency_ms']:.0f}ms")
    for key, level in (quality.get("coverage") or {}).items():
        icon = {"complete": "✅", "partial": "⚠️", "missing": "❌"}.get(level, "?")
        out.append(f"  {icon} {key}")
    counters = quality.get("counters") or {}
    out.append(
        f"  rpc={counters.get('rpc_requests', 0)} api={counters.get('api_requests', 0)} "
        f"cache_hits={counters.get('cache_hits', 0)} deduped={counters.get('deduplicated_requests', 0)} "
        f"wallets={counters.get('wallets_analyzed', 0)} txs={counters.get('transactions_analyzed', 0)}"
    )
    for limitation in risk.confidence.limitations[:6]:
        out.append(f"  ⚠️ {limitation}")
    out.append(BAR)

    out.append("VERDICT")
    for line in verdict_lines(risk):
        out.append(f"  {line}")
    for warning in report.warnings:
        out.append(f"  ⚠️ {warning.splitlines()[0]}")
    out.append("")
    out.append(f"  {report.disclaimer_en}")
    out.append(f"  {report.disclaimer_fr}")
    out.append(BAR)
    out.append(f"Scanned in {report.duration_seconds:.2f}s · {len(report.wallets)} wallets · depth={report.depth.value}")
    return "\n".join(out)


async def scan_once(mint: str, depth: str, *, do_export: bool = False) -> int:
    if not is_valid_pubkey(mint):
        print(f"❌ {mint} is not a valid Solana address.")
        return 2

    settings = get_settings()
    configure_logging(settings.log_level)
    cache = await build_cache(settings.redis_url)
    await init_db()
    async with ProviderHub(settings, cache=cache) as hub:
        orchestrator = ScanOrchestrator(hub, settings)
        try:
            report, context = await orchestrator.scan(
                mint, depth=ScanDepth(depth), requested_by="cli"
            )
        except NotPumpFunError as exc:
            print("❌ NOT A PUMP.FUN TOKEN\n")
            print("This scanner only analyzes Pump.fun launches.")
            if exc.reason:
                print(f"\nReason: {exc.reason}")
            return 3
        print(render(report))
        if do_export:
            paths = export_all(report, context.graph)
            print("\nExported:")
            for kind, path in paths.items():
                print(f"  {kind:<11} {path}")
    await cache.aclose()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scan a Pump.fun token from the terminal")
    parser.add_argument("mint", help="Pump.fun token mint address")
    parser.add_argument("--depth", default="full", choices=["quick", "full", "deep"])
    parser.add_argument("--export", action="store_true", help="also write JSON/CSV/HTML/PNG exports")
    args = parser.parse_args(argv)
    return asyncio.run(scan_once(args.mint, args.depth, do_export=args.export))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
