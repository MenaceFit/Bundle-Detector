from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from app.cache import MemoryCache
from app.config import Settings
from app.db import session as db_session
from app.providers.base import DataQuality
from app.providers.registry import ProviderHub
from tests.support.chain import FakeRpc, SyntheticChain

#: Variables lues par `Settings`. Une valeur héritée du shell ou d'un `.env`
#: rempli ferait passer ou échouer un test selon la machine.
_SETTINGS_ENV_VARS = (
    "DISCORD_TOKEN",
    "DISCORD_GUILD_IDS",
    "DISCORD_AUTOSCAN_CHANNEL_ID",
    "DISCORD_ALERT_CHANNEL_ID",
    "RPC_URL",
    "RPC_WS_URL",
    "RPC_URL_SECONDARY",
    "HELIUS_API_KEY",
    "SOLSCAN_API_KEY",
    "DATABASE_URL",
    "REDIS_URL",
    "MAX_FUNDING_HOPS",
    "FIRST_BUYERS_LIMIT",
    "SCAN_TIMEOUT_SECONDS",
    "LOG_LEVEL",
)


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Coupe la configuration de l'environnement de la machine.

    Sans cela, un `.env` rempli à la racine du dépôt — exactement ce qu'a un
    utilisateur réel — fait échouer des tests qui n'ont rien à voir, avec des
    symptômes qui dépendent de la machine.
    """
    from app.config import Settings, reset_settings_cache

    for name in _SETTINGS_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    reset_settings_cache()
    yield
    reset_settings_cache()


@pytest.fixture(autouse=True)
async def database(tmp_path: Path) -> AsyncIterator[str]:
    """A real, isolated SQLite database per test.

    The persistence path is exercised for real rather than skipped, so a schema
    mistake shows up in the suite instead of only in production.
    """
    url = f"sqlite+aiosqlite:///{tmp_path / 'pfbd-test.db'}"
    await db_session.dispose()
    await db_session.init_db(url)
    yield url
    await db_session.dispose()


@pytest.fixture
def settings() -> Settings:
    return Settings(
        redis_url=None,
        discord_token=None,
        helius_api_key=None,
        solscan_api_key=None,
        first_buyers_limit=50,
    )


@pytest.fixture
def chain() -> SyntheticChain:
    return SyntheticChain()


@pytest.fixture
def hub(settings: Settings, chain: SyntheticChain) -> ProviderHub:
    quality = DataQuality()
    return ProviderHub(
        settings, cache=MemoryCache(), quality=quality, rpc=FakeRpc(chain, quality=quality)
    )
