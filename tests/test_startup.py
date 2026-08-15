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
