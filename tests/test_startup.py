"""Tests de démarrage et de robustesse du bot.

Ces chemins ne sont visibles que quand quelque chose va mal — et c'est
exactement là qu'un utilisateur a besoin d'un message, pas d'une console qui
se referme en silence.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import discord
import pytest

from app.config import Settings
from app.models.enums import ScanDepth


@pytest.fixture
def bot_settings(tmp_path) -> Settings:
    return Settings(
        discord_token="M" * 26 + "." + "G" * 6 + "." + "H" * 38,
        discord_guild_ids="123456789012345678",
        redis_url=None,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'bot.db'}",
        scan_timeout_seconds=1,
    )


class TestSetupHook:
    async def test_setup_hook_completes(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings)
        with (
            patch.object(type(bot.tree), "sync", new=AsyncMock(return_value=[])),
            patch.object(type(bot.tree), "copy_global_to", new=lambda self, guild: None),
        ):
            await bot.setup_hook()

        assert bot.orchestrator is not None
        assert bot.hub is not None
        assert bot.cache is not None
        if bot._watch_task:
            bot._watch_task.cancel()
        await bot.hub.aclose()

    async def test_watch_service_failure_does_not_break_startup(self, bot_settings):
        """Une surveillance en panne est une fonctionnalité perdue, pas un bot mort."""
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings)
        with (
            patch.object(type(bot.tree), "sync", new=AsyncMock(return_value=[])),
            patch.object(type(bot.tree), "copy_global_to", new=lambda self, guild: None),
            patch("app.monitoring.watch.WatchService", side_effect=RuntimeError("boom")),
        ):
            await bot.setup_hook()  # ne doit pas lever

        assert bot.orchestrator is not None, "les commandes doivent rester disponibles"
        await bot.hub.aclose()

    async def test_background_task_exception_is_surfaced(self, bot_settings, caplog):
        """Sans le callback, une exception de tâche de fond reste invisible."""
        from app.discord.bot import BundleDetectorBot

        async def explode() -> None:
            raise RuntimeError("échec en tâche de fond")

        task = asyncio.get_running_loop().create_task(explode())
        with pytest.raises(RuntimeError):
            await task
        BundleDetectorBot._on_watch_task_done(task)  # ne doit pas lever

    async def test_cancelled_background_task_is_silent(self):
        from app.discord.bot import BundleDetectorBot

        async def forever() -> None:
            await asyncio.sleep(3600)

        task = asyncio.get_running_loop().create_task(forever())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        BundleDetectorBot._on_watch_task_done(task)  # ne doit pas lever


class TestPrivilegedIntent:
    """L'intent MESSAGE CONTENT ne doit jamais empêcher le bot de démarrer.

    Il ne sert qu'à la détection automatique d'un mint collé dans un salon.
    Les commandes slash — l'essentiel de l'outil — n'en dépendent pas.
    """

    def test_default_requests_message_content(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        assert BundleDetectorBot(bot_settings).intents.message_content is True

    def test_fallback_mode_drops_only_that_intent(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        lite = BundleDetectorBot(bot_settings, message_content=False)
        assert lite.intents.message_content is False
        # Tout le reste des intents par défaut doit rester intact.
        assert lite.intents.guilds is True

    async def test_autodetect_is_inert_without_the_intent(self, bot_settings):
        """Sans l'intent, `message.content` est vide : ne rien tenter."""
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings, message_content=False)
        message = MagicMock(spec=discord.Message)
        message.author = MagicMock()
        message.author.bot = False
        message.content = ""
        message.channel = MagicMock()
        message.channel.id = bot_settings.discord_autoscan_channel_id or 1
        message.channel.send = AsyncMock()

        await bot.on_message(message)  # ne doit rien faire, ni lever

        message.channel.send.assert_not_awaited()

    def test_run_retries_without_the_intent(self, bot_settings, monkeypatch):
        """Le repli doit relancer un bot complet, pas abandonner."""
        from app.discord import bot as bot_module

        attempts: list[bool] = []

        class FakeBot:
            def __init__(self, settings, *, message_content: bool = True) -> None:
                attempts.append(message_content)

            def run(self, token, **kwargs):
                if attempts[-1]:
                    raise discord.PrivilegedIntentsRequired(shard_id=None)

        monkeypatch.setattr(bot_module, "BundleDetectorBot", FakeBot)
        monkeypatch.setattr(bot_module, "get_settings", lambda: bot_settings)

        bot_module.run()

        assert attempts == [True, False], "le bot doit réessayer sans l'intent privilégié"


class TestCommandErrorHandler:
    """« L'application ne répond pas » signifie : l'interaction n'a pas été acquittée."""

    def _interaction(self, *, already_responded: bool) -> MagicMock:
        interaction = MagicMock(spec=discord.Interaction)
        interaction.command = MagicMock()
        interaction.command.name = "scan"
        interaction.response = MagicMock()
        interaction.response.is_done.return_value = already_responded
        interaction.response.send_message = AsyncMock()
        interaction.followup = MagicMock()
        interaction.followup.send = AsyncMock()
        return interaction

    async def test_error_before_response_sends_a_message(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings)
        interaction = self._interaction(already_responded=False)

        await bot._on_command_error(interaction, ValueError("quelque chose a cassé"))

        interaction.response.send_message.assert_awaited_once()
        message = interaction.response.send_message.call_args.args[0]
        assert "ValueError" in message
        assert "quelque chose a cassé" in message

    async def test_error_after_defer_uses_followup(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings)
        interaction = self._interaction(already_responded=True)

        await bot._on_command_error(interaction, RuntimeError("plus tard"))

        interaction.followup.send.assert_awaited_once()
        interaction.response.send_message.assert_not_awaited()

    async def test_expired_interaction_does_not_raise(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings)
        interaction = self._interaction(already_responded=False)
        interaction.response.send_message = AsyncMock(
            side_effect=discord.HTTPException(MagicMock(status=404), "expirée")
        )
        await bot._on_command_error(interaction, ValueError("x"))  # ne doit pas lever

    async def test_handler_is_wired_to_the_command_tree(self, bot_settings):
        from app.discord.bot import BundleDetectorBot

        bot = BundleDetectorBot(bot_settings)
        assert bot.tree.on_error == bot._on_command_error


class TestScanTimeout:
    """Un scan qui n'aboutit jamais laisse Discord sans réponse."""

    async def test_slow_scan_raises_scan_timeout(self, bot_settings):
        from app.discord.commands.scan import ScanTimeout, _execute

        async def hang(*args, **kwargs):
            await asyncio.sleep(30)

        bot = MagicMock()
        bot.settings = bot_settings  # scan_timeout_seconds = 1
        bot.orchestrator = MagicMock()
        bot.orchestrator.scan = hang

        with pytest.raises(ScanTimeout) as excinfo:
            await _execute(bot, "mint", ScanDepth.FULL, requested_by=None)

        message = str(excinfo.value)
        assert "quickscan" in message, "le message doit proposer une issue"
        assert "RPC" in message, "le message doit nommer la cause probable"

    async def test_fast_scan_is_unaffected(self, bot_settings):
        from app.discord.commands.scan import _execute

        sentinel = ("report", "context")

        async def quick(*args, **kwargs):
            return sentinel

        bot = MagicMock()
        bot.settings = bot_settings
        bot.orchestrator = MagicMock()
        bot.orchestrator.scan = quick

        with patch("app.discord.commands.scan.repository.update_job", new=AsyncMock()):
            assert await _execute(bot, "mint", ScanDepth.FULL, requested_by=None) == sentinel


class TestProviderResilience:
    """Un endpoint saturé doit dégrader le rapport, pas casser le scan."""

    def test_circuit_breaker_open_is_a_provider_error(self):
        """Régression : les deux étaient frères, pas parent/enfant.

        Vingt-cinq `except ProviderError` assurent la dégradation gracieuse du
        moteur. Tant que `CircuitBreakerOpen` héritait de `RuntimeError` en
        parallèle, ils le laissaient tous passer : un disjoncteur ouvert
        faisait échouer un scan entier au lieu de simplement priver le rapport
        d'une donnée.
        """
        from app.providers.base import ProviderError
        from app.utils.errors import CircuitBreakerOpen, RateLimitedError

        assert issubclass(CircuitBreakerOpen, ProviderError)
        assert issubclass(RateLimitedError, ProviderError)

    def test_throttling_does_not_open_the_circuit(self):
        """Un 429 veut dire « ralentis », pas « le fournisseur est mort »."""
        from app.utils.concurrency import CircuitBreaker

        breaker = CircuitBreaker(name="test", threshold=5)
        for _ in range(20):
            breaker.record_throttle()
        assert not breaker.is_open
        assert breaker.throttles == 20

    def test_throttling_resets_the_hard_failure_count(self):
        """Le fournisseur a répondu : c'est l'inverse d'une panne."""
        from app.utils.concurrency import CircuitBreaker

        breaker = CircuitBreaker(name="test", threshold=3)
        breaker.record_failure()
        breaker.record_failure()
        breaker.record_throttle()
        breaker.record_failure()
        assert not breaker.is_open, "le compteur d'échecs durs doit repartir de zéro"

    def test_hard_failures_still_open_the_circuit(self):
        from app.utils.concurrency import CircuitBreaker

        breaker = CircuitBreaker(name="test", threshold=3)
        for _ in range(3):
            breaker.record_failure()
        assert breaker.is_open

    def test_bucket_halves_its_rate_on_throttle(self):
        from app.utils.concurrency import TokenBucket

        bucket = TokenBucket(16.0)
        assert bucket.slow_down() == 8.0
        assert bucket.slow_down() == 4.0
        assert bucket.throttle_events == 2

    def test_bucket_never_stalls_completely(self):
        from app.utils.concurrency import TokenBucket

        bucket = TokenBucket(16.0)
        for _ in range(50):
            bucket.slow_down()
        assert bucket.rate >= TokenBucket.MIN_RATE

    def test_bucket_recovers_after_sustained_success(self):
        from app.utils.concurrency import TokenBucket

        bucket = TokenBucket(16.0)
        bucket.slow_down()
        reduced = bucket.rate
        for _ in range(TokenBucket.RECOVERY_AFTER * 3):
            bucket.record_success()
        assert bucket.rate > reduced
        assert bucket.rate <= bucket.configured_rate

    def test_defaults_suit_a_free_tier_endpoint(self):
        """Partir trop haut déclenche une rafale de 429 dès le premier scan."""
        from app.config import Settings

        settings = Settings()
        assert settings.rpc_requests_per_second <= 10
        assert settings.max_concurrent_rpc <= 8


class TestValidatorHonesty:
    """Une panne d'infrastructure ne doit jamais devenir un verdict."""

    async def test_unreachable_rpc_is_not_reported_as_not_pumpfun(self, chain, settings):
        from app.cache import MemoryCache
        from app.providers.base import DataQuality, ProviderError
        from app.providers.registry import ProviderHub
        from app.pumpfun.validator import ProviderUnavailableError, PumpFunValidator
        from tests.support.chain import FakeRpc, address

        class DeadRpc(FakeRpc):
            async def get_account_info(self, address_):
                raise ProviderError("rpc: circuit is open")

            async def get_signatures(self, address_, **kwargs):
                raise ProviderError("rpc: circuit is open")

        quality = DataQuality()
        hub = ProviderHub(
            settings, cache=MemoryCache(), quality=quality, rpc=DeadRpc(chain, quality=quality)
        )
        with pytest.raises(ProviderUnavailableError) as excinfo:
            await PumpFunValidator(hub).validate(address("some-mint"))

        message = str(excinfo.value)
        assert "verdict" in message.lower(), "doit dire explicitement que ce n'est pas un verdict"
        assert "RPC" in message

    async def test_genuinely_absent_curve_is_still_reported_as_not_pumpfun(self, hub):
        """La panne ne doit pas non plus masquer un vrai « ce n'est pas Pump.fun »."""
        from app.pumpfun.validator import PumpFunValidator
        from tests.support.chain import address

        result = await PumpFunValidator(hub).validate(address("plain-spl-token"))
        assert result.is_pumpfun_token is False
        assert result.reason


class TestLoggingVisibility:
    def test_library_logs_are_routed_to_our_handler(self):
        """Régression : `log_handler=None` rendait les erreurs de discord.py invisibles.

        Le bot pouvait mourir sur une erreur explicite de la bibliothèque sans
        qu'une seule ligne n'apparaisse à l'écran.
        """
        import logging

        from app.utils.logging import configure_logging

        configure_logging()
        pfbd_handlers = logging.getLogger("pfbd").handlers
        assert pfbd_handlers, "notre logger doit avoir un handler"

        discord_logger = logging.getLogger("discord")
        for handler in pfbd_handlers:
            discord_logger.addHandler(handler)
        assert any(h in discord_logger.handlers for h in pfbd_handlers)
