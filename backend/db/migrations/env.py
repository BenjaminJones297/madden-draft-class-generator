"""
backend/db/migrations/env.py — Alembic environment configuration.

Supports both offline (--sql) and online (async engine) migration modes.
"""
from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

# ── Import all ORM models so Alembic can see the full metadata ────────────────
from backend.models.db.base import Base  # noqa: F401 — registers DeclarativeBase
import backend.models.db.models  # noqa: F401 — registers all table classes

from backend.config import settings

# Alembic Config object — gives access to alembic.ini values
config = context.config

# Set up Python logging from alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# MetaData for 'autogenerate' support
target_metadata = Base.metadata


# ---------------------------------------------------------------------------
# Offline mode
# ---------------------------------------------------------------------------

def run_migrations_offline() -> None:
    """Run migrations without a live DB connection, emitting SQL to stdout."""
    url = settings.DATABASE_URL
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


# ---------------------------------------------------------------------------
# Online mode (async)
# ---------------------------------------------------------------------------

def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Create an async engine and run migrations inside a sync wrapper."""
    engine = create_async_engine(settings.DATABASE_URL)
    async with engine.begin() as conn:
        await conn.run_sync(do_run_migrations)
    await engine.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
