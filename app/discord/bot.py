"""Discord bot entry point.

Owns the long-lived shared state — provider hub, cache, orchestrator — so a
scan does not pay connection setup, and hosts the auto-detection listener that
turns a pasted mint address into a scan (§52).
"""

from __future__ import annotations

import asyncio

import discord
from discord.ext import commands

from app.cache import build_cache
from app.config import Settings, get_settings
from app.db import init_db
from app.discord.embeds import not_pumpfun_embed
from app.orchestrator import NotPumpFunError, ScanOrchestrator
from app.providers.registry import ProviderHub
from app.utils.addresses import extract_candidate_mints
from app.utils.logging import configure_logging, get_logger

log = get_logger("DISCORD")

EXTENSIONS = (
    "app.discord.commands.scan",
    "app.discord.commands.wallet",
    "app.discord.commands.admin",
)


class BundleDetectorBot(commands.Bot):
    def __init__(self, settings: Settings | None = None) -> None:
        intents = discord.Intents.default()
        intents.message_content = True  # required for auto-detection in a channel
        super().__init__(command_prefix=commands.when_mentioned, intents=intents, help_command=None)
        self.settings = settings or get_settings()
        self.hub: ProviderHub | None = None
        self.orchestrator: ScanOrchestrator | None = None
        self.cache = None
        #: In-flight scans, so a channel cannot queue ten scans of one mint.
        self._inflight: set[str] = set()
        self._watch_task: asyncio.Task | None = None

    async def setup_hook(self) -> None:
        self.cache = await build_cache(self.settings.redis_url)
        await init_db()
        self.hub = ProviderHub(self.settings, cache=self.cache)
        self.orchestrator = ScanOrchestrator(self.hub, self.settings)

        for extension in EXTENSIONS:
            await self.load_extension(extension)

        if self.settings.guild_ids:
            for guild_id in self.settings.guild_ids:
                guild = discord.Object(id=guild_id)
                self.tree.copy_global_to(guild=guild)
                await self.tree.sync(guild=guild)
            log.info("commands synced", guilds=len(self.settings.guild_ids))
        else:
            await self.tree.sync()
            log.info("commands synced globally")

        from app.monitoring.watch import WatchService

        self._watch_task = asyncio.create_task(WatchService(self).run())

    async def close(self) -> None:
        if self._watch_task:
            self._watch_task.cancel()
        if self.hub:
            await self.hub.aclose()
        if self.cache:
            await self.cache.aclose()
        await super().close()

    async def on_ready(self) -> None:
        log.info("bot ready", user=str(self.user), guilds=len(self.guilds))

    # ------------------------------------------------------------------
    async def on_message(self, message: discord.Message) -> None:
        """Auto-detect a pasted mint in the configured channel (§52)."""
        if message.author.bot or not message.content:
            return
        channel_id = self.settings.discord_autoscan_channel_id
        if not channel_id or message.channel.id != channel_id:
            return

        candidates = extract_candidate_mints(message.content)
        if not candidates:
            return
        mint = candidates[0]
        if mint in self._inflight:
            return

        from app.discord.commands.scan import run_and_render_message

        notice = await message.channel.send(f"🔎 Checking `{mint[:12]}…` for a Pump.fun origin…")
        self._inflight.add(mint)
        try:
            await run_and_render_message(self, message.channel, mint, notice=notice)
        except NotPumpFunError as exc:
            await notice.edit(content=None, embed=not_pumpfun_embed(mint, exc.reason))
        except Exception as exc:  # noqa: BLE001 - a failed autoscan must not kill the bot
            log.exception("autoscan failed", mint=mint, error=str(exc))
            await notice.edit(content=f"❌ Scan failed: {exc}")
        finally:
            self._inflight.discard(mint)

    def claim(self, mint: str) -> bool:
        if mint in self._inflight:
            return False
        self._inflight.add(mint)
        return True

    def release(self, mint: str) -> None:
        self._inflight.discard(mint)


def run() -> None:
    """Démarre le bot, en traduisant les échecs connus en messages lisibles.

    Une traceback Python ne dit pas à un utilisateur quoi faire. Les trois
    causes d'échec réelles (token absent, token refusé, intent non activé) ont
    chacune une action précise, donc chacune a son message.
    """
    settings = get_settings()
    configure_logging(settings.log_level)

    if not settings.discord_token:
        raise SystemExit(
            "\n❌ DISCORD_TOKEN n'est pas défini.\n\n"
            "   1. Copiez le modèle :  cp .env.example .env\n"
            "   2. Ouvrez .env et renseignez DISCORD_TOKEN=...\n"
            "      (Discord Developer Portal → votre application → Bot → Reset Token)\n\n"
            "   Pour un diagnostic complet :  python -m app.main doctor\n"
        )

    try:
        BundleDetectorBot(settings).run(settings.discord_token, log_handler=None)
    except discord.LoginFailure:
        raise SystemExit(
            "\n❌ Discord a refusé le token.\n\n"
            "   Le token est faux, expiré, ou vous avez copié la mauvaise valeur.\n"
            "   Le token du bot n'est PAS l'Application ID ni le Public Key :\n"
            "   Developer Portal → onglet « Bot » → bouton « Reset Token ».\n\n"
            "   Vérifier :  python -m app.main doctor\n"
        ) from None
    except discord.PrivilegedIntentsRequired:
        raise SystemExit(
            "\n❌ L'intent « MESSAGE CONTENT » n'est pas activé.\n\n"
            "   Developer Portal → votre application → onglet « Bot »\n"
            "   → section « Privileged Gateway Intents »\n"
            "   → activez MESSAGE CONTENT INTENT, puis enregistrez.\n\n"
            "   Cet intent sert à détecter un mint collé dans un salon.\n"
        ) from None
    except KeyboardInterrupt:
        print("\nArrêt du bot.")
    except discord.HTTPException as exc:
        raise SystemExit(
            f"\n❌ Discord est injoignable ou a rejeté la connexion : {exc}\n\n"
            "   Vérifiez votre connexion réseau (pare-feu, proxy, VPN).\n"
        ) from None


if __name__ == "__main__":  # pragma: no cover
    run()
