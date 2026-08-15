"""Scan commands: /scan, /quickscan, /deepscan, /bundle, /graph, /compare, /export (§51)."""

from __future__ import annotations

import asyncio
import time

import discord
from discord import app_commands
from discord.ext import commands

from app.db import repository, session_scope
from app.discord.embeds import report as embeds
from app.discord.progress import ProgressReporter
from app.discord.views import ReportView
from app.export import export_all
from app.models.enums import ScanDepth
from app.models.scoring import ScanReport
from app.orchestrator import NotPumpFunError, ScanContext
from app.utils.addresses import is_valid_pubkey
from app.utils.logging import get_logger
from app.utils.timefmt import human_duration

log = get_logger("DISCORD")


class ScanTimeout(RuntimeError):
    """Un scan a dépassé `SCAN_TIMEOUT_SECONDS`."""


async def _execute(
    bot: commands.Bot, mint: str, depth: ScanDepth, *, requested_by: str | None, progress=None
) -> tuple[ScanReport, ScanContext]:
    if bot.orchestrator is None:  # pragma: no cover - defensive
        raise RuntimeError("Bot is still starting up; try again in a moment.")
    started = time.monotonic()
    job_id: int | None = None
    async with session_scope() as session:
        job_id = await repository.create_job(session, mint, depth.value, requested_by)
    timeout = float(bot.settings.scan_timeout_seconds)
    try:
        # Sans plafond, un endpoint RPC lent ou rate-limité laisse l'interaction
        # Discord sans réponse et l'utilisateur ne voit que « L'application ne
        # répond pas ». Un échec explicite vaut mieux qu'une attente infinie.
        result = await asyncio.wait_for(
            bot.orchestrator.scan(mint, depth=depth, progress=progress, requested_by=requested_by),
            timeout=timeout,
        )
    except TimeoutError as exc:
        async with session_scope() as session:
            await repository.update_job(
                session, job_id, status="failed", error="timeout", duration=time.monotonic() - started
            )
        raise ScanTimeout(
            f"le scan a dépassé {timeout:.0f} s. Votre endpoint RPC est probablement trop lent "
            "ou rate-limité — essayez `/quickscan`, ou passez à un endpoint payant "
            "(voir RPC_URL dans .env)."
        ) from exc
    except Exception as exc:
        async with session_scope() as session:
            await repository.update_job(
                session, job_id, status="failed", error=str(exc), duration=time.monotonic() - started
            )
        raise
    async with session_scope() as session:
        await repository.update_job(
            session,
            job_id,
            status="completed",
            duration=result[0].duration_seconds,
            result={"bundle": result[0].risk.bundle.score, "confidence": result[0].risk.confidence.score},
        )
    return result


async def run_and_render_message(
    bot: commands.Bot,
    channel: discord.abc.Messageable,
    mint: str,
    *,
    depth: ScanDepth = ScanDepth.FULL,
    notice: discord.Message | None = None,
) -> None:
    """Used by the auto-detection path, which has no interaction to defer."""
    report, context = await _execute(bot, mint, depth, requested_by="autodetect")
    view = ReportView(report, context.graph)
    if notice is not None:
        await notice.edit(content=None, embeds=embeds.build_all(report), view=view)
    else:
        await channel.send(embeds=embeds.build_all(report), view=view)


class ScanCommands(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    # ------------------------------------------------------------------
    async def _run(self, interaction: discord.Interaction, mint: str, depth: ScanDepth) -> None:
        mint = mint.strip()
        if not is_valid_pubkey(mint):
            await interaction.response.send_message(
                f"`{mint[:24]}` is not a valid Solana address.", ephemeral=True
            )
            return
        if not self.bot.claim(mint):
            await interaction.response.send_message(
                "That mint is already being scanned right now.", ephemeral=True
            )
            return

        await interaction.response.defer(thinking=False)
        reporter = ProgressReporter(interaction, mint=mint)
        await reporter.start()
        try:
            report, context = await _execute(
                self.bot,
                mint,
                depth,
                requested_by=str(interaction.user.id),
                progress=reporter.update,
            )
        except NotPumpFunError as exc:
            await reporter.fail("Not a Pump.fun token.")
            await interaction.followup.send(embed=embeds.not_pumpfun_embed(mint, exc.reason))
            return
        except ScanTimeout as exc:
            await reporter.fail(str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("scan failed", mint=mint, error=str(exc))
            await reporter.fail(f"{type(exc).__name__}: {str(exc)[:350]}")
            return
        finally:
            self.bot.release(mint)

        await reporter.finish(
            f"✅ Scan complete in {report.duration_seconds:.1f}s — {len(report.wallets)} wallets analysed."
        )
        await interaction.followup.send(
            embeds=embeds.build_all(report), view=ReportView(report, context.graph)
        )

    # ------------------------------------------------------------------
    @app_commands.command(name="scan", description="Full Pump.fun bundle analysis of a token")
    @app_commands.describe(token="Pump.fun token mint address")
    async def scan(self, interaction: discord.Interaction, token: str) -> None:
        await self._run(interaction, token, ScanDepth.FULL)

    @app_commands.command(name="quickscan", description="Fast analysis: buyers, funding, basic bundle score")
    @app_commands.describe(token="Pump.fun token mint address")
    async def quickscan(self, interaction: discord.Interaction, token: str) -> None:
        await self._run(interaction, token, ScanDepth.QUICK)

    @app_commands.command(
        name="deepscan", description="Deep analysis: full history, clusters, cross-launch matching"
    )
    @app_commands.describe(token="Pump.fun token mint address")
    async def deepscan(self, interaction: discord.Interaction, token: str) -> None:
        await self._run(interaction, token, ScanDepth.DEEP)

    @app_commands.command(name="bundle", description="Bundle detection detail for a token")
    @app_commands.describe(token="Pump.fun token mint address")
    async def bundle(self, interaction: discord.Interaction, token: str) -> None:
        token = token.strip()
        if not is_valid_pubkey(token):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        try:
            report, context = await _execute(
                self.bot, token, ScanDepth.FULL, requested_by=str(interaction.user.id)
            )
        except NotPumpFunError as exc:
            await interaction.followup.send(embed=embeds.not_pumpfun_embed(token, exc.reason))
            return
        cluster_embeds = [embeds.bundle_embed(report), embeds.evidence_embed(report)]
        cluster_embeds.extend(embeds.cluster_embed(c) for c in report.clusters[:2])
        await interaction.followup.send(
            embeds=cluster_embeds, view=ReportView(report, context.graph)
        )

    @app_commands.command(name="graph", description="Render the wallet bubble map for a token")
    @app_commands.describe(token="Pump.fun token mint address")
    async def graph(self, interaction: discord.Interaction, token: str) -> None:
        token = token.strip()
        if not is_valid_pubkey(token):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        try:
            report, context = await _execute(
                self.bot, token, ScanDepth.FULL, requested_by=str(interaction.user.id)
            )
        except NotPumpFunError as exc:
            await interaction.followup.send(embed=embeds.not_pumpfun_embed(token, exc.reason))
            return
        from app.export import to_bubble_map_html, to_png

        files = []
        png = to_png(report, context.graph)
        if png:
            files.append(discord.File(png, filename="bubble_map.png"))
        interactive = to_bubble_map_html(report, context.graph)
        if interactive:
            files.append(discord.File(interactive, filename="bubble_map.html"))
        await interaction.followup.send(
            content=f"Wallet graph for {report.token.display_symbol}.",
            files=files,
            embed=embeds.overview_embed(report),
            view=ReportView(report, context.graph),
        )

    @app_commands.command(name="export", description="Export a full scan as JSON, CSV, HTML and PNG")
    @app_commands.describe(token="Pump.fun token mint address")
    async def export(self, interaction: discord.Interaction, token: str) -> None:
        token = token.strip()
        if not is_valid_pubkey(token):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        try:
            report, context = await _execute(
                self.bot, token, ScanDepth.DEEP, requested_by=str(interaction.user.id)
            )
        except NotPumpFunError as exc:
            await interaction.followup.send(embed=embeds.not_pumpfun_embed(token, exc.reason))
            return
        paths = export_all(report, context.graph)
        await interaction.followup.send(
            content=f"Export for {report.token.display_symbol}.",
            files=[discord.File(p, filename=p.name) for p in paths.values()][:10],
        )

    @app_commands.command(name="compare", description="Compare the wallet clusters of two Pump.fun tokens")
    @app_commands.describe(token1="First mint", token2="Second mint")
    async def compare(self, interaction: discord.Interaction, token1: str, token2: str) -> None:
        token1, token2 = token1.strip(), token2.strip()
        if not (is_valid_pubkey(token1) and is_valid_pubkey(token2)):
            await interaction.response.send_message("Both arguments must be valid mints.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        try:
            report_a, _ = await _execute(self.bot, token1, ScanDepth.FULL, requested_by=str(interaction.user.id))
            report_b, _ = await _execute(self.bot, token2, ScanDepth.FULL, requested_by=str(interaction.user.id))
        except NotPumpFunError as exc:
            await interaction.followup.send(embed=embeds.not_pumpfun_embed(exc.mint, exc.reason))
            return

        wallets_a = {w.address for w in report_a.wallets}
        wallets_b = {w.address for w in report_b.wallets}
        shared = sorted(wallets_a & wallets_b)

        embed = discord.Embed(title="🔀 TOKEN COMPARISON", color=0x8B5CF6)
        for report in (report_a, report_b):
            embed.add_field(
                name=report.token.display_symbol,
                value=(
                    f"`{report.mint[:16]}…`\n"
                    f"bundle {report.risk.bundle.score} · confidence {report.risk.confidence.score}%\n"
                    f"{len(report.wallets)} wallets · {len(report.clusters)} clusters\n"
                    f"age {human_duration(report.token.age_seconds)}"
                ),
                inline=True,
            )
        embed.add_field(
            name="Shared early buyers",
            value=(
                f"**{len(shared)}** wallets bought both coins early"
                + (
                    "\n" + ", ".join(w[:8] + "…" for w in shared[:15])
                    if shared
                    else "\nNo overlap in the analysed buyer sets."
                )
            )[:1024],
            inline=False,
        )
        creators_match = (
            report_a.token.creator
            and report_a.token.creator == report_b.token.creator
        )
        embed.add_field(
            name="Same creator",
            value="YES — both coins were launched by the same wallet." if creators_match else "No",
            inline=False,
        )
        embed.set_footer(
            text="Overlap alone is not evidence: active launch traders appear on many coins."
        )
        await interaction.followup.send(embed=embed)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(ScanCommands(bot))
