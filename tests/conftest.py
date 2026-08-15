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
