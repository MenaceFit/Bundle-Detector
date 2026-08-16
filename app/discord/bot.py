"""Discord bot entry point.

Owns the long-lived shared state — provider hub, cache, orchestrator — so a
scan does not pay connection setup, and hosts the auto-detection listener that
turns a pasted mint address into a scan (§52).
"""

from __future__ import annotations

import asyncio
import logging

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
    def __init__(self, settings: Settings | None = None, *, message_content: bool = True) -> None:
        """``message_content`` gouverne la seule fonctionnalité qui en dépend.

        L'intent MESSAGE CONTENT ne sert qu'à la détection automatique d'un
        mint collé dans un salon. Les commandes slash n'en ont aucun besoin, et
        refuser de démarrer parce qu'une fonctionnalité *optionnelle* n'est pas
        autorisée serait un mauvais compromis : `run()` relance donc le bot
        sans cet intent plutôt que d'abandonner.
        """
        intents = discord.Intents.default()
        intents.message_content = message_content
        super().__init__(command_prefix=commands.when_mentioned, intents=intents, help_command=None)
        self.settings = settings or get_settings()
        self.hub: ProviderHub | None = None
        self.orchestrator: ScanOrchestrator | None = None
        self.cache = None
        #: In-flight scans, so a channel cannot queue ten scans of one mint.
        self._inflight: set[str] = set()
        self._watch_task: asyncio.Task | None = None
        self._ready_announced = False
        self.tree.on_error = self._on_command_error

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

        # Les tâches de fond ne doivent jamais empêcher le bot de répondre :
        # une surveillance en panne est une fonctionnalité perdue, pas un bot mort.
        try:
            from app.monitoring.watch import WatchService

            self._watch_task = asyncio.create_task(WatchService(self).run())
            self._watch_task.add_done_callback(self._on_watch_task_done)
        except Exception as exc:  # noqa: BLE001
            log.exception("watch service could not start; commands remain available", error=str(exc))

    @staticmethod
    def _on_watch_task_done(task: asyncio.Task) -> None:
        """Sans ceci, une exception dans la tâche de fond reste invisible."""
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            log.error(
                "watch service stopped; commands still work",
                error=f"{type(error).__name__}: {error}",
            )

    async def close(self) -> None:
        log.info("shutting down")
        if self._watch_task:
            self._watch_task.cancel()
        if self.hub:
            await self.hub.aclose()
        if self.cache:
            await self.cache.aclose()
        await super().close()

    async def on_ready(self) -> None:
        self._ready_announced = True
        log.info("bot ready", user=str(self.user), guilds=len(self.guilds))
        print(f"\n✅ Bot en ligne : {self.user}  ({len(self.guilds)} serveur(s))")
        print("   Tapez /scan dans Discord. Ctrl+C pour arrêter.")
        if not self.intents.message_content:
            print(
                "\n   ℹ️  Détection automatique désactivée (intent MESSAGE CONTENT non\n"
                "      autorisé). Toutes les commandes slash fonctionnent normalement.\n"
                "      Pour coller un mint directement dans un salon : Developer Portal\n"
                "      → Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT."
            )
        print()

    async def on_disconnect(self) -> None:
        log.warning("disconnected from Discord (reconnection will be attempted)")

    async def on_resumed(self) -> None:
        log.info("connection resumed")

    async def _on_command_error(
        self, interaction: discord.Interaction, error: BaseException
    ) -> None:
        """Toute commande qui échoue doit dire pourquoi.

        Sans ce gestionnaire, une exception non rattrapée laisse l'interaction
        sans réponse et Discord affiche « L'application ne répond pas », ce qui
        n'apprend rien à l'utilisateur et rien à l'opérateur.
        """
        log.exception(
            "slash command failed",
            command=getattr(interaction.command, "name", "?"),
            error=f"{type(error).__name__}: {error}",
        )
        message = (
            f"❌ La commande a échoué.\n```\n{type(error).__name__}: {str(error)[:400]}\n```\n"
            "Le détail complet est dans la console du bot."
        )
        try:
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)
        except discord.HTTPException:
            pass  # l'interaction a expiré : le log ci-dessus reste la trace

    async def on_error(self, event_method: str, /, *args: object, **kwargs: object) -> None:
        """Une erreur d'événement ne doit pas passer inaperçue.

        Le comportement par défaut de discord.py écrit sur stderr via son
        propre logger ; comme nous configurons le logging nous-mêmes, on le
        route ici pour que rien ne se perde.
        """
        log.exception("unhandled error in event", event=event_method)

    # ------------------------------------------------------------------
    async def on_message(self, message: discord.Message) -> None:
        """Auto-detect a pasted mint in the configured channel (§52).

        Sans l'intent MESSAGE CONTENT, ``message.content`` arrive vide pour les
        messages des autres utilisateurs : la détection est alors inopérante,
        et c'est signalé au démarrage plutôt que de rester un mystère.
        """
        if not self.intents.message_content:
            return
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

    # discord.py journalise ses propres erreurs — connexion perdue, échec de
    # handshake, exception dans une tâche interne. Lui passer `log_handler=None`
    # coupait cette sortie : le bot pouvait mourir en silence, l'utilisateur ne
    # voyait qu'une console qui se referme. On route la bibliothèque vers notre
    # propre handler pour que ses messages apparaissent avec les nôtres.
    discord_logger = logging.getLogger("discord")
    discord_logger.setLevel(logging.INFO)
    for handler in logging.getLogger("pfbd").handlers:
        discord_logger.addHandler(handler)
    # Le heartbeat du websocket est bavard et sans intérêt ici.
    logging.getLogger("discord.gateway").setLevel(logging.WARNING)

    # Les avertissements PyNaCl/davey concernent le support voix, que ce bot
    # n'utilise pas : ce sont deux lignes de bruit avant chaque démarrage.
    logging.getLogger("discord.client").addFilter(
        lambda record: "voice will NOT be supported" not in record.getMessage()
    )

    try:
        BundleDetectorBot(settings).run(settings.discord_token, log_handler=None)
    except discord.PrivilegedIntentsRequired:
        # L'intent MESSAGE CONTENT ne sert qu'à la détection automatique d'un
        # mint collé dans un salon. Plutôt que de refuser de démarrer pour une
        # fonctionnalité optionnelle, on relance sans lui : les commandes slash
        # — c'est-à-dire l'essentiel de l'outil — fonctionnent immédiatement.
        print(
            "\n⚠️  L'intent « MESSAGE CONTENT » n'est pas autorisé pour ce bot.\n"
            "   Démarrage sans la détection automatique ; les commandes slash\n"
            "   (/scan, /quickscan, /deepscan…) fonctionnent normalement.\n\n"
            "   Pour l'activer plus tard : Developer Portal → votre application\n"
            "   → onglet « Bot » → Privileged Gateway Intents\n"
            "   → MESSAGE CONTENT INTENT → Save Changes.\n"
        )
        log.warning("message content intent unavailable; auto-detection disabled")
        try:
            BundleDetectorBot(settings, message_content=False).run(
                settings.discord_token, log_handler=None
            )
        except KeyboardInterrupt:
            print("\nArrêt du bot.")
            return
    except discord.LoginFailure:
        raise SystemExit(
            "\n❌ Discord a refusé le token.\n\n"
            "   Le token est faux, expiré, ou vous avez copié la mauvaise valeur.\n"
            "   Le token du bot n'est PAS l'Application ID ni le Public Key :\n"
            "   Developer Portal → onglet « Bot » → bouton « Reset Token ».\n\n"
            "   Vérifier :  python -m app.main doctor\n"
        ) from None
    except KeyboardInterrupt:
        print("\nArrêt du bot.")
        return
    except discord.HTTPException as exc:
        raise SystemExit(
            f"\n❌ Discord est injoignable ou a rejeté la connexion : {exc}\n\n"
            "   Vérifiez votre connexion réseau (pare-feu, proxy, VPN).\n"
        ) from None
    except Exception as exc:  # noqa: BLE001 - dernier filet avant la sortie
        log.exception("bot stopped unexpectedly", error=str(exc))
        raise SystemExit(
            f"\n❌ Le bot s'est arrêté sur une erreur inattendue : "
            f"{type(exc).__name__}: {exc}\n\n"
            "   La trace complète est au-dessus. Pour plus de détail :\n"
            "     LOG_LEVEL=DEBUG python -m app.main bot\n"
        ) from None

    # `Client.run()` rend la main uniquement quand la connexion s'est fermée.
    # Sans ce message, une fermeture propre (token révoqué en cours de route,
    # session invalidée par Discord) ressemble à « le bot s'est fermé tout seul ».
    print(
        "\n⚠️  La connexion à Discord s'est fermée et le bot s'est arrêté.\n"
        "   Causes habituelles : token réinitialisé pendant l'exécution, bot\n"
        "   expulsé du serveur, ou coupure réseau prolongée.\n"
        "   Diagnostic :  python -m app.main doctor\n"
    )


if __name__ == "__main__":  # pragma: no cover
    run()
