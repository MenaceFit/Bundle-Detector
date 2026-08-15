"""Wallet-centric commands: /wallet, /dev, /history (§51)."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from app.analyzers.entities import EntityClassifier
from app.analyzers.history import HistoryAnalyzer
from app.models.enums import EntityType
from app.pumpfun.constants import LAMPORTS_PER_SOL, PUMP_FUN_PROGRAM_ID
from app.pumpfun.events import parse_transaction
from app.pumpfun.graduation import read_global_initial_reserves
from app.utils.addresses import is_valid_pubkey, shorten
from app.utils.logging import get_logger
from app.utils.timefmt import human_age, human_duration

log = get_logger("DISCORD")

SOLSCAN_ACCOUNT = "https://solscan.io/account/{}"


class WalletCommands(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="wallet", description="Profile a wallet's Pump.fun behaviour")
    @app_commands.describe(address="Wallet address")
    async def wallet(self, interaction: discord.Interaction, address: str) -> None:
        address = address.strip()
        if not is_valid_pubkey(address):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)

        hub = self.bot.hub
        classifier = EntityClassifier(self.bot.settings.scoring)
        label = classifier.classify(address, default=EntityType.UNKNOWN)

        balance = await hub.rpc.get_balance(address)
        signatures = await hub.rpc.get_signatures(address, limit=1000)
        oldest = await hub.rpc.get_oldest_signature(address, max_pages=3)

        initial_reserves = await read_global_initial_reserves(hub)
        history = await HistoryAnalyzer(
            hub, sample_size=150, max_wallets=1, initial_real_tokens=initial_reserves
        ).analyze([address], current_mint="")
        record = history.wallets.get(address)

        embed = discord.Embed(
            title="WALLET ANALYSIS",
            description=f"[{address}]({SOLSCAN_ACCOUNT.format(address)})",
            color=0x0EA5E9,
        )
        embed.add_field(name="SOL balance", value=f"{balance / LAMPORTS_PER_SOL:.4f}", inline=True)
        embed.add_field(
            name="First seen",
            value=human_age((oldest or {}).get("blockTime")) + " ago" if oldest else "unknown",
            inline=True,
        )
        embed.add_field(
            name="Recent transactions",
            value=f"{len(signatures)}{'+' if len(signatures) >= 1000 else ''}",
            inline=True,
        )
        if label.entity_type is not EntityType.UNKNOWN:
            embed.add_field(
                name="Classification",
                value=f"{label.entity_type.value}{f' — {label.label}' if label.label else ''}",
                inline=False,
            )
        if record:
            embed.add_field(
                name="Pump.fun launches traded",
                value=f"{record.launch_count}{'+' if record.partial else ''}",
                inline=True,
            )
            embed.add_field(name="Very early entries", value=str(record.ultra_early_entries), inline=True)
            embed.add_field(name="Behaviour", value=record.classify(), inline=True)
            if record.launches:
                embed.add_field(
                    name="Sampled launches",
                    value=", ".join(shorten(m) for m in sorted(record.launches)[:12])[:1024],
                    inline=False,
                )
        embed.set_footer(
            text="History is sampled from recent transactions — counts are lower bounds. "
            "Frequent early entries are a behavioural signal, not proof of wrongdoing."
        )
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="dev", description="Analyse a creator wallet's Pump.fun launch history")
    @app_commands.describe(address="Creator wallet address")
    async def dev(self, interaction: discord.Interaction, address: str) -> None:
        address = address.strip()
        if not is_valid_pubkey(address):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)

        hub = self.bot.hub
        signatures = await hub.rpc.get_signatures_paged(address, max_signatures=500)
        sigs = [s["signature"] for s in signatures if s.get("signature")]
        raw_map = await hub.rpc.get_transactions(sigs)

        launches: list[tuple[str, str | None, int | None]] = []
        seen: set[str] = set()
        for signature, raw in raw_map.items():
            parsed = parse_transaction(raw, signature)
            if parsed is None or PUMP_FUN_PROGRAM_ID not in parsed.programs:
                continue
            for event in parsed.events:
                if event.name != "CreateEvent":
                    continue
                if (event.get("creator") or event.get("user")) != address:
                    continue
                mint = event.get("mint")
                if not mint or mint in seen:
                    continue
                seen.add(mint)
                launches.append((mint, event.get("symbol"), event.get("timestamp")))

        launches.sort(key=lambda item: item[2] or 0, reverse=True)

        graduated = 0
        if launches:
            from app.pumpfun.events import decode_account_data, decode_bonding_curve
            from app.pumpfun.pda import bonding_curve_pda

            accounts = await hub.rpc.get_multiple_accounts(
                [bonding_curve_pda(mint) for mint, _, _ in launches[:20]]
            )
            for account in accounts:
                state = decode_bonding_curve(decode_account_data(account) or b"")
                if state and state.get("complete"):
                    graduated += 1

        embed = discord.Embed(
            title="👨‍💻 CREATOR HISTORY",
            description=f"[{address}]({SOLSCAN_ACCOUNT.format(address)})",
            color=0xA855F7,
        )
        embed.add_field(name="Launches found", value=f"{len(launches)}", inline=True)
        embed.add_field(name="Graduated (of first 20 checked)", value=str(graduated), inline=True)
        embed.add_field(name="Transactions sampled", value=str(len(signatures)), inline=True)
        if launches:
            embed.add_field(
                name="Recent launches",
                value="\n".join(
                    f"`{mint[:12]}…` {symbol or ''} — {human_age(ts)} ago"
                    for mint, symbol, ts in launches[:10]
                )[:1024],
                inline=False,
            )
        else:
            embed.add_field(
                name="No launches found",
                value="No Pump.fun `create` instruction was found in the sampled history.",
                inline=False,
            )
        embed.set_footer(text="Sampled from the most recent transactions; older launches may be missed.")
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="history", description="A wallet's recent Pump.fun launch participation")
    @app_commands.describe(address="Wallet address")
    async def history(self, interaction: discord.Interaction, address: str) -> None:
        address = address.strip()
        if not is_valid_pubkey(address):
            await interaction.response.send_message("Invalid Solana address.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)

        hub = self.bot.hub
        initial_reserves = await read_global_initial_reserves(hub)
        analysis = await HistoryAnalyzer(
            hub, sample_size=200, max_wallets=1, initial_real_tokens=initial_reserves
        ).analyze([address], current_mint="")
        record = analysis.wallets.get(address)

        embed = discord.Embed(title="📜 PUMP.FUN HISTORY", description=f"`{address}`", color=0x0EA5E9)
        if not record or not record.participations:
            embed.add_field(
                name="Nothing found",
                value="No Pump.fun trades in the sampled transaction window.",
                inline=False,
            )
            await interaction.followup.send(embed=embed)
            return

        embed.add_field(name="Distinct launches", value=str(record.launch_count), inline=True)
        embed.add_field(name="Trades sampled", value=str(len(record.participations)), inline=True)
        embed.add_field(name="Classification", value=record.classify(), inline=True)
        embed.add_field(
            name="Entry depth (how early into the curve)",
            value=(
                f"very early: {record.ultra_early_entries} · early: {record.early_entries} · "
                f"mid: {record.moderate_entries}"
            ),
            inline=False,
        )
        rows = [
            f"`{p.mint[:10]}…` {'BUY ' if p.is_buy else 'SELL'} {p.quote_amount:.3f} SOL"
            + (f" · depth {p.entry_depth * 100:.2f}%" if p.entry_depth is not None else "")
            + f" · {human_duration((record.participations[0].block_time or 0) - (p.block_time or 0))} ago"
            for p in record.participations[:12]
        ]
        embed.add_field(name="Recent activity", value="\n".join(rows)[:1024], inline=False)
        embed.set_footer(
            text="Entry depth is the fraction of the bonding curve already sold when the wallet bought."
        )
        await interaction.followup.send(embed=embed)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(WalletCommands(bot))
