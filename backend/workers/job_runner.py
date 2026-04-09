"""
backend/workers/job_runner.py — ARQ worker entry point.

Run with:
    arq backend.workers.job_runner.WorkerSettings
"""
from __future__ import annotations

from arq.connections import RedisSettings

from backend.config import settings


# ---------------------------------------------------------------------------
# Task functions
# ---------------------------------------------------------------------------

async def run_draft_pipeline(ctx: dict, job_id: str, config: dict) -> None:
    """ARQ task: run the full 6-step draft-class pipeline."""
    from backend.services.pipeline_service import run_pipeline

    await run_pipeline(job_id, config)


async def run_roster_pipeline(ctx: dict, job_id: str, config: dict) -> None:
    """ARQ task: run the 3-step roster pipeline (7 → 3 → 8)."""
    from backend.services.roster_pipeline_service import run_roster_pipeline as _run

    await _run(job_id, config)


# ---------------------------------------------------------------------------
# Worker configuration
# ---------------------------------------------------------------------------

class WorkerSettings:
    functions = [run_draft_pipeline, run_roster_pipeline]
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    max_jobs = 4
    job_timeout = 3600  # 1 hour — rating generation can take a while
