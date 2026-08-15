"""Discord embed builders (§54 - §58, §90, §112, §113).

Layout rule that governs every embed here: **evidence first, verdict last**.
The reader should see what was observed, then what the engine concluded from
it, never the other way round.
"""

from __future__ import annotations

from typing import Any

import discord

from app.models.cluster import Cluster
from app.models.enums import PairType, RiskLevel
from app.models.scoring import DISCLAIMER_EN, DISCLAIMER_FR, ScanReport
from app.pumpfun.lifecycle import describe_state
from app.scoring.bundle import explain
from app.scoring.risk import verdict_lines
from app.utils.addresses import shorten
from app.utils.timefmt import human_duration

COLOR_BY_LEVEL = {
    RiskLevel.LOW: 0x22C55E,
    RiskLevel.MEDIUM: 0xFACC15,
    RiskLevel.HIGH: 0xF97316,
    RiskLevel.CRITICAL: 0xEF4444,
}

SOLSCAN_TOKEN = "https://solscan.io/token/{}"
SOLSCAN_ACCOUNT = "https://solscan.io/account/{}"
SOLSCAN_TX = "https://solscan.io/tx/{}"
PUMPFUN_COIN = "https://pump.fun/coin/{}"


def token_links(mint: str) -> str:
    """Explorer links. Only URL shapes that are known to exist are emitted (§61)."""
    return f"[Solscan]({SOLSCAN_TOKEN.format(mint)}) · [pump.fun]({PUMPFUN_COIN.format(mint)})"


def overview_embed(report: ScanReport) -> discord.Embed:
    risk = report.risk
    token = report.token
    level = risk.risk_level

    embed = discord.Embed(
        title=f"🚨 PUMP.FUN RISK ANALYSIS — {token.display_symbol}",
        description=(
            f"**{token.name or 'Unknown'}**\n"
            f"`{token.mint}`\n{token_links(token.mint)}"
        ),
        color=COLOR_BY_LEVEL[level],
    )

    age = human_duration(token.age_seconds) if token.age_seconds is not None else "unknown"
    embed.add_field(name="Launch", value=f"{age} ago", inline=True)
    embed.add_field(name="Status", value=describe_state(token.lifecycle, token.graduation), inline=True)
    embed.add_field(
        name="Pair",
        value=token.pair.value if token.pair is not PairType.UNKNOWN else "UNKNOWN",
        inline=True,
    )

    embed.add_field(name="Bundle", value=f"**{risk.bundle.score}**/100", inline=True)
    embed.add_field(
        name="Coordination",
        value=f"{max(risk.funding_coordination, risk.buy_coordination)}/100",
        inline=True,
    )
    embed.add_field(name="Wallet risk", value=f"{risk.early_buyer_risk}/100", inline=True)

    embed.add_field(name="Dev risk", value=f"{risk.dev_risk}/100", inline=True)
    embed.add_field(name="Overall", value=f"{risk.overall_risk}/100", inline=True)
    embed.add_field(
        name="Confidence", value=f"{risk.confidence.score}% ({risk.confidence.level})", inline=True
    )

    if token.mayhem.enabled:
        embed.add_field(
            name="⚠️ Mayhem Mode",
            value=(
                f"Active ({token.mayhem.flagged_trades} flagged trades). Automated protocol activity "
                "is measured separately and excluded from the coordination signals."
            ),
            inline=False,
        )

    embed.set_footer(
        text=f"{len(report.wallets)} wallets analysed · {report.duration_seconds:.1f}s · "
        f"data quality {report.data_quality.get('score', 0) * 100:.0f}%"
    )
    return embed


def evidence_embed(report: ScanReport, *, limit: int = 6) -> discord.Embed:
    """Evidence before verdict (§113)."""
    embed = discord.Embed(
        title="🔍 EVIDENCE",
        description="What was actually observed on chain, before any conclusion.",
        color=0x38BDF8,
    )
    if not report.evidence:
        embed.add_field(
            name="No findings",
            value="No coordination evidence was found in the data that could be retrieved.",
            inline=False,
        )
        return embed

    for index, item in enumerate(report.evidence[:limit], start=1):
        lines = [item.detail]
        if item.wallets:
            lines.append("Wallets: " + ", ".join(shorten(w) for w in item.wallets[:6]))
        if item.signatures:
            lines.append(
                "Transactions: "
                + ", ".join(f"[{shorten(s, 4, 4)}]({SOLSCAN_TX.format(s)})" for s in item.signatures[:4])
            )
        else:
            lines.append("_No direct transaction reference for this finding._")
        if item.caveat:
            lines.append(f"⚖️ {item.caveat}")
        embed.add_field(
            name=f"Evidence #{index} — {item.title}",
            value="\n".join(lines)[:1024],
            inline=False,
        )
    return embed


def bundle_embed(report: ScanReport) -> discord.Embed:
    """🧩 BUNDLE DETECTION (§55) with the explainable breakdown (§85)."""
    cluster = report.top_cluster()
    risk = report.risk
    embed = discord.Embed(title="🧩 BUNDLE DETECTION", color=COLOR_BY_LEVEL[risk.risk_level])

    if cluster is None:
        embed.description = "No wallet cluster met the minimum size for bundle analysis."
        return embed

    signals = cluster.signals
    embed.add_field(name="Potential linked wallets", value=str(cluster.size), inline=True)
    embed.add_field(name="Common funder", value=_yes_no(cluster.common_funders), inline=True)
    embed.add_field(
        name="Common intermediary", value=_yes_no(cluster.common_intermediaries), inline=True
    )
    embed.add_field(name="Funding similarity", value=_pct(signals.funding_amount_similarity), inline=True)
    embed.add_field(name="Funding timing", value=_pct(signals.funding_timing_similarity), inline=True)
    embed.add_field(name="Buy timing", value=_pct(signals.buy_timing_similarity), inline=True)
    embed.add_field(name="Buy amount similarity", value=_pct(signals.buy_amount_similarity), inline=True)
    embed.add_field(name="Wallet age similarity", value=_pct(signals.wallet_age_similarity), inline=True)
    embed.add_field(name="Historical overlap", value=_pct(signals.historical_overlap), inline=True)

    if cluster.recurring_launches:
        embed.add_field(
            name="Repeated cluster",
            value=(
                f"{cluster.recurring_similarity * 100:.0f}% similar to a cluster seen on "
                f"{len(cluster.recurring_launches)} previous launch(es)"
            ),
            inline=False,
        )

    breakdown = "\n".join(explain(risk.bundle)) or "No contributing signals."
    embed.add_field(name=f"Bundle score {risk.bundle.score}/100", value=breakdown[:1024], inline=False)
    embed.add_field(
        name="Independent signal families",
        value=(
            f"{risk.bundle.independent_signals} — a high score requires several independent families "
            "to agree, so no single signal can produce one."
        ),
        inline=False,
    )
    if cluster.infrastructure_funders:
        embed.add_field(
            name="Damped signals",
            value=(
                "Shared funding from "
                + ", ".join(shorten(a) for a in cluster.infrastructure_funders[:3])
                + " was treated as shared infrastructure, not coordination."
            ),
            inline=False,
        )
    return embed


def creator_embed(report: ScanReport) -> discord.Embed:
    """👨‍💻 CREATOR ANALYSIS (§56)."""
    creator = report.creator
    embed = discord.Embed(title="👨‍💻 CREATOR ANALYSIS", color=0xA855F7)
    if creator is None:
        embed.description = "The creator wallet could not be identified."
        return embed

    embed.add_field(
        name="Creator",
        value=f"[{shorten(creator.address, 6, 6)}]({SOLSCAN_ACCOUNT.format(creator.address)})",
        inline=False,
    )
    embed.add_field(name="Pump.fun launches", value=str(creator.launches_total), inline=True)
    embed.add_field(name="Graduated", value=str(creator.launches_graduated), inline=True)
    embed.add_field(name="Abandoned", value=str(creator.launches_abandoned), inline=True)
    if creator.funding_source:
        embed.add_field(
            name="Funded by",
            value=f"[{shorten(creator.funding_source)}]({SOLSCAN_ACCOUNT.format(creator.funding_source)})",
            inline=True,
        )
    embed.add_field(name="Related buyer wallets", value=str(len(creator.linked_buyers)), inline=True)
    embed.add_field(name="Creator risk", value=f"{creator.risk_score}/100", inline=True)
    if creator.risk_reasons:
        embed.add_field(
            name="Why", value="\n".join(f"• {r}" for r in creator.risk_reasons)[:1024], inline=False
        )
    if creator.history_is_partial:
        embed.set_footer(text="Creator history was sampled, not exhaustive — counts are lower bounds.")
    return embed


def wallets_embed(report: ScanReport, *, limit: int = 12) -> discord.Embed:
    """Wallet table (§57)."""
    embed = discord.Embed(title="👛 MOST NOTABLE WALLETS", color=0x0EA5E9)
    ranked = sorted(report.wallets, key=lambda p: p.risk_score, reverse=True)[:limit]
    if not ranked:
        embed.description = "No buyer wallets were identified."
        return embed

    header = f"{'wallet':<12}{'SOL':>8}{'age':>9}{'buy':>9}{'cl':>4}{'risk':>6}"
    rows = [header, "─" * len(header)]
    for profile in ranked:
        rows.append(
            f"{shorten(profile.address, 4, 4):<12}"
            f"{(profile.sol_balance or 0):>8.2f}"
            f"{human_duration(profile.age_seconds):>9}"
            f"{(profile.first_buy.quote_amount if profile.first_buy else 0):>9.3f}"
            f"{(profile.cluster_id or '-'):>4}"
            f"{profile.risk_score:>6}"
        )
    embed.description = "```\n" + "\n".join(rows)[:3900] + "\n```"
    embed.set_footer(text="cl = cluster id · age is measured from the wallet's earliest known signature")
    return embed


def wallet_detail_embed(report: ScanReport, address: str) -> discord.Embed:
    """Single-wallet detail (§58)."""
    profile = report.wallet(address)
    embed = discord.Embed(
        title="WALLET ANALYSIS",
        description=f"[{address}]({SOLSCAN_ACCOUNT.format(address)})",
        color=0x0EA5E9,
    )
    if profile is None:
        embed.description = f"`{address}` was not part of this scan."
        return embed

    embed.add_field(name="Age", value=human_duration(profile.age_seconds), inline=True)
    embed.add_field(name="Current SOL", value=f"{profile.sol_balance or 0:.4f}", inline=True)
    embed.add_field(
        name="Funding",
        value=f"{profile.funding_amount:.4f}" if profile.funding_amount else "not observed",
        inline=True,
    )
    if profile.direct_funder:
        embed.add_field(
            name="Funding source",
            value=f"[{shorten(profile.direct_funder)}]({SOLSCAN_ACCOUNT.format(profile.direct_funder)})",
            inline=True,
        )
    if profile.funding_to_buy_seconds is not None:
        embed.add_field(
            name="Funded before buy",
            value=human_duration(profile.funding_to_buy_seconds, precise=True),
            inline=True,
        )
    if profile.first_buy:
        embed.add_field(
            name="First buy",
            value=(
                f"{profile.first_buy.quote_amount:.4f} · "
                f"{human_duration(profile.first_buy.seconds_after_launch)} after launch"
            ),
            inline=True,
        )
    if profile.pumpfun_launches is not None:
        embed.add_field(
            name="Pump.fun launches",
            value=f"{profile.pumpfun_launches}{'+' if profile.history_is_partial else ''}",
            inline=True,
        )
        embed.add_field(name="Very early entries", value=str(profile.early_entries_10s), inline=True)
    embed.add_field(name="Cluster", value=str(profile.cluster_id or "none"), inline=True)
    embed.add_field(name="Risk", value=f"{profile.risk_score}/100", inline=True)
    if profile.risk_reasons:
        embed.add_field(
            name="Why", value="\n".join(f"• {r}" for r in profile.risk_reasons)[:1024], inline=False
        )
    if profile.first_seen_is_bounded:
        embed.set_footer(text="Age hit the history paging limit — the wallet may be older than shown.")
    return embed


def status_embed(report: ScanReport) -> discord.Embed:
    """Token status report (§90) plus launch timeline (§10)."""
    token = report.token
    embed = discord.Embed(title="📊 TOKEN STATUS", color=0x64748B)
    embed.add_field(name="Pair", value=token.pair.value, inline=True)
    embed.add_field(
        name="Bonding curve",
        value="GRADUATED" if token.graduation.graduated else "ACTIVE",
        inline=True,
    )
    embed.add_field(
        name="Graduation",
        value=(
            "YES"
            if token.graduation.graduated
            else f"{token.graduation.progress * 100:.0f}% complete"
            if token.graduation.progress is not None
            else "unknown"
        ),
        inline=True,
    )
    if token.graduation.pumpswap_pool:
        embed.add_field(
            name="PumpSwap pool",
            value=f"[{shorten(token.graduation.pumpswap_pool)}]({SOLSCAN_ACCOUNT.format(token.graduation.pumpswap_pool)})",
            inline=True,
        )
    embed.add_field(name="Mayhem", value="YES" if token.mayhem.enabled else "NO", inline=True)
    embed.add_field(name="Age", value=human_duration(token.age_seconds), inline=True)

    timeline = " · ".join(f"{k}: {v}" for k, v in report.timeline.items() if v)
    if timeline:
        embed.add_field(name="Buyers over time", value=timeline[:1024], inline=False)
    fresh = " · ".join(f"{k}: {v}" for k, v in report.fresh_wallet_buckets.items() if v)
    if fresh:
        embed.add_field(name="Wallet freshness", value=fresh[:1024], inline=False)

    slots = report.slot_analysis
    if slots.get("buys_considered"):
        embed.add_field(
            name="Slot analysis",
            value=(
                f"{slots.get('distinct_slots')} distinct slots across {slots['buys_considered']} early buys · "
                f"{slots.get('wallets_sharing_a_slot', 0)} wallets shared a slot\n"
                f"_{slots.get('caveat', '')}_"
            )[:1024],
            inline=False,
        )
    return embed


def data_quality_embed(report: ScanReport) -> discord.Embed:
    """DATA QUALITY (§49) — what answered, what did not, and what that costs."""
    quality: dict[str, Any] = report.data_quality
    embed = discord.Embed(
        title=f"DATA QUALITY: {quality.get('score', 0) * 100:.0f}%", color=0x64748B
    )
    providers = quality.get("providers", {})
    if providers:
        icons = {"ok": "✅", "degraded": "⚠️", "failed": "❌", "disabled": "➖"}
        embed.add_field(
            name="Providers",
            value="\n".join(
                f"{icons.get(info['status'], '?')} {name} — {info['requests']} req, "
                f"{info['avg_latency_ms']:.0f}ms avg"
                for name, info in providers.items()
            )[:1024],
            inline=False,
        )
    coverage = quality.get("coverage", {})
    if coverage:
        icons = {"complete": "✅", "partial": "⚠️", "missing": "❌"}
        embed.add_field(
            name="Coverage",
            value="\n".join(f"{icons.get(v, '?')} {k.replace('_', ' ')}" for k, v in coverage.items())[:1024],
            inline=False,
        )
    counters = quality.get("counters", {})
    if counters:
        embed.add_field(
            name="Observability",
            value=(
                f"RPC {counters.get('rpc_requests', 0)} · API {counters.get('api_requests', 0)} · "
                f"cache {counters.get('cache_hits', 0)}/{counters.get('cache_hits', 0) + counters.get('cache_misses', 0)} · "
                f"deduped {counters.get('deduplicated_requests', 0)}\n"
                f"wallets {counters.get('wallets_analyzed', 0)} · txs {counters.get('transactions_analyzed', 0)} · "
                f"clusters {counters.get('clusters_detected', 0)} · {counters.get('elapsed_seconds', 0)}s"
            )[:1024],
            inline=False,
        )
    if report.risk.confidence.limitations:
        embed.add_field(
            name="Limitations",
            value="\n".join(f"• {x}" for x in report.risk.confidence.limitations[:6])[:1024],
            inline=False,
        )
    return embed


def verdict_embed(report: ScanReport) -> discord.Embed:
    """FINAL VERDICT (§112) — always shown after the evidence."""
    risk = report.risk
    lines = verdict_lines(risk)
    embed = discord.Embed(
        title="FINAL VERDICT",
        description=f"**{lines[0]}**\n{lines[1]}\n{lines[2]}",
        color=COLOR_BY_LEVEL[risk.risk_level],
    )
    embed.add_field(name="Classification", value=risk.classification.value, inline=False)
    if report.warnings:
        embed.add_field(name="Caveats", value="\n".join(f"• {w}" for w in report.warnings)[:1024], inline=False)
    embed.add_field(name="⚠️", value=f"{DISCLAIMER_EN}\n\n_{DISCLAIMER_FR}_"[:1024], inline=False)
    return embed


def cluster_embed(cluster: Cluster) -> discord.Embed:
    """Detail for one cluster (§30)."""
    embed = discord.Embed(title=f"CLUSTER #{cluster.cluster_id}", color=0xF97316)
    signals = cluster.signals
    embed.add_field(name="Members", value=f"{cluster.size} wallets", inline=True)
    embed.add_field(name="Detected by", value=cluster.method, inline=True)
    embed.add_field(name="Cluster score", value=f"{cluster.score}/100", inline=True)
    embed.add_field(name="Common funder", value=_yes_no(cluster.common_funders), inline=True)
    embed.add_field(name="Common intermediary", value=_yes_no(cluster.common_intermediaries), inline=True)
    embed.add_field(name="Funding amount similarity", value=_pct(signals.funding_amount_similarity), inline=True)
    embed.add_field(name="Funding timing", value=_pct(signals.funding_timing_similarity), inline=True)
    embed.add_field(name="Buy amount", value=_pct(signals.buy_amount_similarity), inline=True)
    embed.add_field(name="Buy timing", value=_pct(signals.buy_timing_similarity), inline=True)
    embed.add_field(name="Wallet age", value=_pct(signals.wallet_age_similarity), inline=True)
    embed.add_field(name="Historical overlap", value=_pct(signals.historical_overlap), inline=True)
    embed.add_field(
        name="Wallets",
        value=", ".join(shorten(m) for m in cluster.members[:20])[:1024],
        inline=False,
    )
    if cluster.notes:
        embed.add_field(name="Notes", value="\n".join(f"• {n}" for n in cluster.notes)[:1024], inline=False)
    return embed


def not_pumpfun_embed(mint: str, reason: str | None) -> discord.Embed:
    embed = discord.Embed(
        title="❌ NOT A PUMP.FUN TOKEN",
        description="This scanner only analyzes Pump.fun launches.",
        color=0xEF4444,
    )
    embed.add_field(name="Mint", value=f"`{mint}`", inline=False)
    if reason:
        embed.add_field(name="Why", value=reason, inline=False)
    return embed


def _pct(value: float) -> str:
    return f"{value * 100:.0f}%"


def _yes_no(values: list[str]) -> str:
    return "YES" if values else "NO"


def build_all(report: ScanReport) -> list[discord.Embed]:
    """Full report ordering: overview → status → evidence → bundle → creator → verdict."""
    embeds = [
        overview_embed(report),
        status_embed(report),
        evidence_embed(report),
        bundle_embed(report),
    ]
    if report.creator:
        embeds.append(creator_embed(report))
    embeds.append(verdict_embed(report))
    return embeds
