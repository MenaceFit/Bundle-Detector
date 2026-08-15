"""Interactive report controls (§59).

The buttons expose the deeper views without re-running the scan: everything is
served from the report object held in memory by the view.
"""

from __future__ import annotations

import discord

from app.discord.embeds import report as embeds
from app.export import export_all, to_bubble_map_html, to_png
from app.graph.builder import GraphBundle
from app.models.scoring import ScanReport
from app.utils.logging import get_logger

log = get_logger("DISCORD")


class ReportView(discord.ui.View):
    def __init__(self, report: ScanReport, graph: GraphBundle | None, *, timeout: float = 900.0) -> None:
        super().__init__(timeout=timeout)
        self.report = report
        self.graph = graph
        if not report.clusters:
            self.show_clusters.disabled = True

    @discord.ui.button(label="🕸 View Bubble Map", style=discord.ButtonStyle.primary)
    async def bubble_map(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.defer(thinking=True, ephemeral=True)
        files: list[discord.File] = []
        png = to_png(self.report, self.graph)
        if png:
            files.append(discord.File(png, filename="bubble_map.png"))
        interactive = to_bubble_map_html(self.report, self.graph)
        if interactive:
            files.append(discord.File(interactive, filename="bubble_map.html"))
        if not files:
            await interaction.followup.send("No graph could be rendered for this scan.", ephemeral=True)
            return
        await interaction.followup.send(
            content=(
                "Bubble map. The HTML file is interactive (zoom, pan, cluster filter, "
                "hide infrastructure) and opens offline in any browser."
            ),
            files=files,
            ephemeral=True,
        )

    @discord.ui.button(label="👛 Wallets", style=discord.ButtonStyle.secondary)
    async def show_wallets(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.send_message(
            embed=embeds.wallets_embed(self.report), view=WalletSelectView(self.report), ephemeral=True
        )

    @discord.ui.button(label="🧩 Clusters", style=discord.ButtonStyle.secondary)
    async def show_clusters(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        cluster_embeds = [embeds.cluster_embed(c) for c in self.report.clusters[:4]]
        await interaction.response.send_message(embeds=cluster_embeds, ephemeral=True)

    @discord.ui.button(label="📊 Data quality", style=discord.ButtonStyle.secondary)
    async def show_quality(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.send_message(
            embed=embeds.data_quality_embed(self.report), ephemeral=True
        )

    @discord.ui.button(label="📦 Export", style=discord.ButtonStyle.success)
    async def export(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.defer(thinking=True, ephemeral=True)
        try:
            paths = export_all(self.report, self.graph)
        except Exception as exc:  # noqa: BLE001 - export must not kill the view
            log.warning("export failed", error=str(exc))
            await interaction.followup.send(f"Export failed: {exc}", ephemeral=True)
            return
        files = [discord.File(path, filename=path.name) for path in paths.values()]
        await interaction.followup.send(
            content="Full export: JSON, CSV, self-contained HTML report and bubble map.",
            files=files[:10],
            ephemeral=True,
        )


class WalletSelectView(discord.ui.View):
    """Dropdown for per-wallet detail (§58)."""

    def __init__(self, report: ScanReport, *, timeout: float = 600.0) -> None:
        super().__init__(timeout=timeout)
        self.report = report
        ranked = sorted(report.wallets, key=lambda p: p.risk_score, reverse=True)[:25]
        options = [
            discord.SelectOption(
                label=f"{p.address[:10]}… · risk {p.risk_score}",
                value=p.address,
                description=(
                    f"cluster {p.cluster_id or '-'} · "
                    f"buy {p.first_buy.quote_amount:.3f}" if p.first_buy else "no buy recorded"
                )[:100],
            )
            for p in ranked
        ]
        if options:
            self.add_item(_WalletSelect(report, options))


class _WalletSelect(discord.ui.Select):
    def __init__(self, report: ScanReport, options: list[discord.SelectOption]) -> None:
        super().__init__(placeholder="Inspect a wallet…", options=options, min_values=1, max_values=1)
        self.report = report

    async def callback(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_message(
            embed=embeds.wallet_detail_embed(self.report, self.values[0]), ephemeral=True
        )
