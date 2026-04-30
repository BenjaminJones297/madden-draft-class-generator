"""
backend/routers/roster_pipeline.py — Roster pipeline endpoints.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.session import get_db
from backend.models.db.models import PipelineJob
from backend.models.schemas.pipeline import JobStatus, RosterPipelineRunRequest

router = APIRouter(prefix="/roster-pipeline", tags=["roster-pipeline"])


# ---------------------------------------------------------------------------
# POST /roster-pipeline/run
# ---------------------------------------------------------------------------

@router.post("/run", response_model=JobStatus, status_code=202)
async def run_roster_pipeline(
    req: RosterPipelineRunRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create a roster pipeline job and enqueue it for background processing."""
    job_id = str(uuid.uuid4())
    job = PipelineJob(
        id=job_id,
        job_type="roster",
        status="queued",
        total_steps=3,
        current_step=0,
        progress_pct=0,
        config=req.model_dump(),
        created_at=datetime.now(timezone.utc),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    try:
        import arq

        from backend.config import settings

        redis = await arq.create_pool(arq.connections.RedisSettings.from_dsn(settings.REDIS_URL))
        await redis.enqueue_job("run_roster_pipeline", job_id, req.model_dump())
        await redis.aclose()
    except Exception:
        pass

    return JobStatus(
        id=job.id,
        job_type=job.job_type,
        status=job.status,
        current_step=job.current_step or 0,
        total_steps=job.total_steps,
        progress_pct=job.progress_pct or 0,
        error_message=job.error_message,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


# ---------------------------------------------------------------------------
# GET /roster-pipeline/jobs
# ---------------------------------------------------------------------------

@router.get("/jobs", response_model=List[JobStatus])
async def list_roster_jobs(db: AsyncSession = Depends(get_db)):
    """Return all roster pipeline jobs ordered newest-first."""
    result = await db.execute(
        select(PipelineJob)
        .where(PipelineJob.job_type == "roster")
        .order_by(PipelineJob.created_at.desc())
    )
    jobs = result.scalars().all()
    return [
        JobStatus(
            id=j.id,
            job_type=j.job_type,
            status=j.status,
            current_step=j.current_step or 0,
            total_steps=j.total_steps,
            progress_pct=j.progress_pct or 0,
            error_message=j.error_message,
            created_at=j.created_at,
            started_at=j.started_at,
            completed_at=j.completed_at,
        )
        for j in jobs
    ]


# ---------------------------------------------------------------------------
# GET /roster-pipeline/jobs/{job_id}
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}", response_model=JobStatus)
async def get_roster_job(job_id: str, db: AsyncSession = Depends(get_db)):
    """Return the status of a single roster pipeline job."""
    result = await db.execute(select(PipelineJob).where(PipelineJob.id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(
        id=job.id,
        job_type=job.job_type,
        status=job.status,
        current_step=job.current_step or 0,
        total_steps=job.total_steps,
        progress_pct=job.progress_pct or 0,
        error_message=job.error_message,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )
