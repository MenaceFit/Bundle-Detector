"""Admin and monitoring commands: /settings, /watch, /unwatch, /autoscan (§92, §93, §98)."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from app.analyzers.entities import describe_registry
from app.db import repository, session_scope
from app.utils.addresses import is_valid_pubkey
from app.utils.logging import get_logger

log = get_logger("DISCORD")


class AdminCommands(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="settings", description="Show the engine configuration and thresholds")
    async def settings(self, interaction: discord.Interaction) -> None:
        settings = self.bot.settings
        scoring = settings.scoring
        weights = scoring.weights

        embed = discord.Embed(title="⚙️ SETTINGS", color=0x64748B)
        embed.add_field(
            name="Analysis depth",
            value=(
                f"first buyers: {settings.first_buyers_limit}\n"
                f"funding hops: {settings.max_funding_hops}\n"
                f"history signatures: {settings.history_max_signatures}\n"
                f"scan timeout: {settings.scan_timeout_seconds}s"
            ),
            inline=True,
        )
        embed.add_field(
            name="Analysis windows (s)",
            value="\n".join(f"{name}: {seconds}" for name, seconds in settings.windows.as_ordered()),
            inline=True,
        )
        alerts = settings.alerts
        embed.add_field(
            name="Alert thresholds",
            value=(
                f"LOW ≤ {alerts.low_max}\nMEDIUM ≤ {alerts.medium_max}\n"
                f"HIGH ≤ {alerts.high_max}\nCRITICAL > {alerts.high_max}"
            ),
            inline=True,
        )
        embed.add_field(
            name="Bundle weights",
            value="\n".join(f"{k.replace('_', ' ')}: {v:.0f}" for k, v in weights.model_dump().items()),
            inline=True,
        )
        embed.add_field(
            name="Evidence rules",
            value=(
                f"minimum independent signal families: {scoring.min_independent_signals}\n"
                f"cap with 1 family: {scoring.single_signal_ceiling:.0f}\n"
                f"cap with {scoring.min_independent_signals - 1} families: {scoring.two_signal_ceiling:.0f}\n"
                f"minimum cluster size: {scoring.min_cluster_size}"
            ),
            inline=True,
        )

        providers = []
        for name, health in sorted(self.bot.hub.quality.providers.items()):
            providers.append(f"{health.status.icon} {name}")
        embed.add_field(name="Providers", value="\n".join(providers) or "none", inline=True)

        registry = describe_registry()
        embed.add_field(
            name="Known entities",
            value=(
                f"{registry['total']} labelled addresses · {registry['needs_verification']} flagged "
                "for verification"
            ),
            inline=False,
        )

        async with session_scope() as session:
            stats = await repository.stats(session)
        if stats:
            embed.add_field(
                name="Database",
                value=" · ".join(f"{k}: {v}" for k, v in stats.items()),
                inline=False,
            )
        embed.set_footer(text="Weights and windows are configured in app/config.py and the environment.")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="watch", description="Watch a token and alert on score changes")
    @app_commands.describe(token="Pump.fun token mint address")
    async def watch(self, interaction: discord.Interaction, token: str) -> None:
        token = token.strip()
        if not is_valid_pubkey(token):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        async with session_scope() as session:
            created = await repository.add_watch(
                session, token, interaction.channel_id or 0, str(interaction.user.id)
            )
        await interaction.response.send_message(
            (
                f"👁 Now watching `{token[:16]}…` in this channel. You will be alerted on new linked "
                "buyers, score changes, coordinated exits and graduation."
                if created
                else f"Already watching `{token[:16]}…` here."
            ),
            ephemeral=False,
        )

    @app_commands.command(name="unwatch", description="Stop watching a token in this channel")
    @app_commands.describe(token="Pump.fun token mint address")
    async def unwatch(self, interaction: discord.Interaction, token: str) -> None:
        token = token.strip()
        async with session_scope() as session:
            stopped = await repository.stop_watch(session, token, interaction.channel_id or 0)
        await interaction.response.send_message(
            f"Stopped watching `{token[:16]}…`." if stopped else "That token was not being watched here.",
            ephemeral=True,
        )

    @app_commands.command(
        name="autoscan", description="Auto-scan new Pump.fun launches and alert on suspicious ones"
    )
    @app_commands.describe(
        enabled="Turn discovery mode on or off",
        min_buyers="Minimum distinct buyers before a launch is analysed",
        min_bundle_score="Minimum bundle score required to raise an alert",
        max_age_seconds="Only consider launches younger than this",
    )
    async def autoscan(
        self,
        interaction: discord.Interaction,
        enabled: bool,
        min_buyers: int = 8,
        min_bundle_score: int = 60,
        max_age_seconds: int = 900,
    ) -> None:
        from app.monitoring.watch import AutoScanConfig, WatchService

        service: WatchService | None = getattr(self.bot, "watch_service", None)
        config = AutoScanConfig(
            enabled=enabled,
            channel_id=interaction.channel_id or 0,
            min_buyers=max(1, min_buyers),
            min_bundle_score=max(0, min(100, min_bundle_score)),
            max_age_seconds=max(30, max_age_seconds),
        )
        if service is not None:
            service.autoscan = config

        if not enabled:
            await interaction.response.send_message("Discovery mode disabled.", ephemeral=True)
            return

        embed = discord.Embed(title="🛰 DISCOVERY MODE", color=0x22C55E)
        embed.description = (
            "Monitoring new Pump.fun launches. Only launches that pass every filter are analysed, "
            "and only those that clear the alert threshold are posted."
        )
        embed.add_field(name="Max age", value=f"{config.max_age_seconds}s", inline=True)
        embed.add_field(name="Min buyers", value=str(config.min_buyers), inline=True)
        embed.add_field(name="Min bundle score", value=str(config.min_bundle_score), inline=True)
        embed.set_footer(
            text="Discovery uses a quick scan per candidate; confirm anything interesting with /deepscan."
        )
        await interaction.response.send_message(embed=embed)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AdminCommands(bot))
