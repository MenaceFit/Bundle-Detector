"""Watch mode and discovery mode (§92, §93, §95, §96, §97).

**Watch mode** re-scans a subscribed token on a schedule and posts an alert
only when something *changed*: the bundle score moved, new wallets joined a
cluster, the coin graduated, or a coordinated exit appeared.  Re-posting the
same score every few minutes would train people to ignore the alerts.

**Discovery mode** watches every new Pump.fun launch and applies a funnel:

    launches detected → passes filters → enough activity → analysed →
    suspicious → alerted

Only the last stage reaches Discord.  The funnel counts are tracked so an
operator can see the ratio and tune the filters.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

import discord

from app.db import repository, session_scope
from app.models.enums import Classification, ScanDepth
from app.models.scoring import ScanReport
from app.orchestrator import NotPumpFunError
from app.utils.addresses import shorten
from app.utils.logging import get_logger
from app.utils.timefmt import human_duration

log = get_logger("WATCH")

#: Seconds between watch-list passes.
WATCH_INTERVAL = 120.0
#: Minimum bundle-score movement that justifies an alert.
SCORE_DELTA_THRESHOLD = 8


@dataclass
class AutoScanConfig:
    enabled: bool = False
    channel_id: int = 0
    max_age_seconds: int = 900
    min_buyers: int = 8
    min_bundle_score: int = 60
    min_confidence: int = 55
    #: Cap on concurrent discovery scans so discovery never starves /scan.
    max_concurrent: int = 2


@dataclass
class FunnelCounters:
    detected: int = 0
    valid: int = 0
    enough_activity: int = 0
    analysed: int = 0
    suspicious: int = 0
    alerted: int = 0

    def as_text(self) -> str:
        return (
            f"{self.detected} detected → {self.valid} valid → {self.enough_activity} with activity → "
            f"{self.analysed} analysed → {self.suspicious} suspicious → {self.alerted} alerted"
        )


@dataclass
class WatchService:
    bot: object
    autoscan: AutoScanConfig = field(default_factory=AutoScanConfig)
    funnel: FunnelCounters = field(default_factory=FunnelCounters)

    def __post_init__(self) -> None:
        # Expose the service so /autoscan can reconfigure it live.
        self.bot.watch_service = self  # type: ignore[attr-defined]
        self._discovery_task: asyncio.Task | None = None
        self._semaphore = asyncio.Semaphore(self.autoscan.max_concurrent)

    async def run(self) -> None:
        await self.bot.wait_until_ready()  # type: ignore[attr-defined]
        log.info("watch service started")
        self._discovery_task = asyncio.create_task(self._discovery_loop())
        while True:
            try:
                await self._watch_pass()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                log.exception("watch pass failed", error=str(exc))
            await asyncio.sleep(WATCH_INTERVAL)

    # ------------------------------------------------------------------
    async def _watch_pass(self) -> None:
        async with session_scope() as session:
            watches = await repository.active_watches(session)
        if not watches:
            return
        for watch in watches:
            try:
                await self._check_watch(watch)
            except NotPumpFunError:
                async with session_scope() as session:
                    await repository.stop_watch(session, watch.mint, watch.channel_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("watch check failed", mint=watch.mint, error=str(exc))

    async def _check_watch(self, watch) -> None:
        orchestrator = self.bot.orchestrator  # type: ignore[attr-defined]
        report, _ = await orchestrator.scan(watch.mint, depth=ScanDepth.QUICK)
        previous = watch.last_bundle_score or 0
        current = report.risk.bundle.score
        reasons = self._change_reasons(report, previous, current)

        async with session_scope() as session:
            fresh = await repository.active_watches(session)
            for row in fresh:
                if row.mint == watch.mint and row.channel_id == watch.channel_id:
                    row.last_bundle_score = current
                    from datetime import UTC, datetime

                    row.last_checked = datetime.now(UTC)

        if not reasons:
            return

        channel = self.bot.get_channel(watch.channel_id)  # type: ignore[attr-defined]
        if channel is None:
            return
        embed = discord.Embed(
            title="🚨 SCORE UPDATE",
            description=f"{report.token.display_symbol} `{watch.mint[:16]}…`",
            color=0xF97316,
        )
        embed.add_field(name="Bundle", value=f"{previous} → **{current}**", inline=True)
        embed.add_field(name="Confidence", value=f"{report.risk.confidence.score}%", inline=True)
        embed.add_field(name="Status", value=report.token.lifecycle.label, inline=True)
        embed.add_field(name="Reason", value="\n".join(f"• {r}" for r in reasons)[:1024], inline=False)
        await channel.send(embed=embed)

        async with session_scope() as session:
            await repository.record_alert(
                session,
                mint=watch.mint,
                level=report.risk.risk_level.value,
                bundle_score=current,
                confidence=report.risk.confidence.score,
                reason="; ".join(reasons),
                channel_id=watch.channel_id,
            )

    @staticmethod
    def _change_reasons(report: ScanReport, previous: int, current: int) -> list[str]:
        reasons: list[str] = []
        if abs(current - previous) >= SCORE_DELTA_THRESHOLD:
            cluster = report.top_cluster()
            if cluster:
                reasons.append(
                    f"Bundle score moved {previous} → {current}; largest cluster now has "
                    f"{cluster.size} wallets"
                )
            else:
                reasons.append(f"Bundle score moved {previous} → {current}")
        if report.token.graduation.graduated and report.token.graduation.pumpswap_pool:
            reasons.append("Coin graduated and is now trading on PumpSwap")
        if report.risk.sell_coordination >= 60:
            reasons.append(f"Coordinated selling detected ({report.risk.sell_coordination}/100)")
        return reasons

    # ------------------------------------------------------------------
    async def _discovery_loop(self) -> None:
        from app.monitoring.realtime import LaunchFeed

        hub = self.bot.hub  # type: ignore[attr-defined]
        settings = self.bot.settings  # type: ignore[attr-defined]
        feed = LaunchFeed(hub, ws_url=settings.rpc_ws_url)
        while True:
            if not self.autoscan.enabled:
                await asyncio.sleep(5.0)
                continue
            try:
                launches = await feed.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("discovery poll failed", error=str(exc))
                await asyncio.sleep(10.0)
                continue

            self.funnel.detected += len(launches)
            for launch in launches:
                if not self.autoscan.enabled:
                    break
                age = time.time() - (launch.block_time or time.time())
                if age > self.autoscan.max_age_seconds:
                    continue
                self.funnel.valid += 1
                asyncio.create_task(self._evaluate_launch(launch))
            await asyncio.sleep(6.0)

    async def _evaluate_launch(self, launch) -> None:
        async with self._semaphore:
            orchestrator = self.bot.orchestrator  # type: ignore[attr-defined]
            try:
                report, _ = await orchestrator.scan(launch.mint, depth=ScanDepth.QUICK)
            except NotPumpFunError:
                return
            except Exception as exc:  # noqa: BLE001
                log.debug("discovery scan failed", mint=launch.mint, error=str(exc))
                return

            buyers = len(report.wallets)
            if buyers < self.autoscan.min_buyers:
                return
            self.funnel.enough_activity += 1
            self.funnel.analysed += 1

            risk = report.risk
            if risk.bundle.score < self.autoscan.min_bundle_score:
                return
            if risk.confidence.score < self.autoscan.min_confidence:
                return
            if risk.classification in {
                Classification.CEX_FUNDED_USERS,
                Classification.MAYHEM_ACTIVITY,
                Classification.INSUFFICIENT_DATA,
            }:
                # The engine found a benign explanation — do not raise an alarm.
                return
            self.funnel.suspicious += 1

            channel = self.bot.get_channel(self.autoscan.channel_id)  # type: ignore[attr-defined]
            if channel is None:
                return
            await channel.send(embed=self._alert_embed(report))
            self.funnel.alerted += 1
            async with session_scope() as session:
                await repository.record_alert(
                    session,
                    mint=report.mint,
                    level=risk.risk_level.value,
                    bundle_score=risk.bundle.score,
                    confidence=risk.confidence.score,
                    reason=risk.classification.value,
                    channel_id=self.autoscan.channel_id,
                )

    def _alert_embed(self, report: ScanReport) -> discord.Embed:
        risk = report.risk
        cluster = report.top_cluster()
        embed = discord.Embed(
            title="🚨 PUMP.FUN EARLY WARNING",
            description=f"**{report.token.display_symbol}**\n`{report.mint}`",
            color=0xEF4444,
        )
        embed.add_field(name="Age", value=human_duration(report.token.age_seconds), inline=True)
        embed.add_field(name="Buyers", value=str(len(report.wallets)), inline=True)
        embed.add_field(
            name="Potentially linked", value=str(cluster.size if cluster else 0), inline=True
        )
        embed.add_field(name="Bundle score", value=f"{risk.bundle.score}/100", inline=True)
        embed.add_field(name="Confidence", value=f"{risk.confidence.score}%", inline=True)
        embed.add_field(name="Level", value=f"{risk.risk_level.emoji} {risk.risk_level.value}", inline=True)
        top = [e.title for e in report.evidence[:3]]
        embed.add_field(
            name="Reason", value="\n".join(f"• {t}" for t in top) or risk.classification.value, inline=False
        )
        if cluster:
            embed.add_field(
                name="Wallets",
                value=", ".join(shorten(m) for m in cluster.members[:10])[:1024],
                inline=False,
            )
        embed.set_footer(text=f"Quick scan · run /deepscan {report.mint[:8]}… to confirm · {self.funnel.as_text()}")
        return embed
