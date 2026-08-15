"""Async engine and session management.

Defaults to SQLite so the tool runs with no infrastructure; point
``DATABASE_URL`` at PostgreSQL for production.  The database is treated as an
*accelerator and a memory*, never as a required dependency: if it is
unavailable, a scan still completes from RPC and simply loses cross-launch
history.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.db.models import Base
from app.utils.logging import get_logger

log = get_logger("DB")

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine(url: str | None = None) -> AsyncEngine:
    global _engine
    if _engine is None:
        target = url or get_settings().database_url
        kwargs: dict = {"echo": False, "future": True}
        if not target.startswith("sqlite"):
            kwargs.update(pool_size=10, max_overflow=20, pool_pre_ping=True)
        _engine = create_async_engine(target, **kwargs)
        log.info("engine created", url=target.split("://", 1)[0])
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def init_db(url: str | None = None) -> bool:
    """Create tables. Returns ``False`` when the database is unreachable."""
    try:
        engine = get_engine(url)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    except Exception as exc:  # noqa: BLE001 - the DB is optional by design
        log.warning("database unavailable; continuing without persistence", error=str(exc))
        return False
    log.info("database ready")
    return True


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession | None]:
    """Yield a session, or ``None`` if the database cannot be reached."""
    try:
        factory = get_session_factory()
    except Exception as exc:  # noqa: BLE001
        log.debug("session factory unavailable", error=str(exc))
        yield None
        return
    session = factory()
    try:
        yield session
        await session.commit()
    except Exception as exc:  # noqa: BLE001 - persistence must not break a scan
        await session.rollback()
        log.warning("database write failed", error=str(exc))
    finally:
        await session.close()


async def dispose() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
