"""
backend/routers/pipeline.py — Draft-class pipeline endpoints.
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
from backend.models.schemas.pipeline import JobStatus, PipelineRunRequest

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


# ---------------------------------------------------------------------------
# POST /pipeline/run
# ---------------------------------------------------------------------------

@router.post("/run", response_model=JobStatus, status_code=202)
async def run_pipeline(
    req: PipelineRunRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create a pipeline job and enqueue it for background processing."""
    job_id = str(uuid.uuid4())
    job = PipelineJob(
        id=job_id,
        job_type="draft_class",
        status="queued",
        total_steps=6,
        current_step=0,
        progress_pct=0,
        config=req.model_dump(),
        created_at=datetime.now(timezone.utc),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    # Enqueue ARQ task (import lazily so the module loads without Redis running)
    try:
        import arq

        from backend.config import settings

        redis = await arq.create_pool(arq.connections.RedisSettings.from_dsn(settings.REDIS_URL))
        await redis.enqueue_job("run_draft_pipeline", job_id, req.model_dump())
        await redis.aclose()
    except Exception:
        # If Redis is unavailable the job is still persisted; worker will retry
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
# GET /pipeline/jobs
# ---------------------------------------------------------------------------

@router.get("/jobs", response_model=List[JobStatus])
async def list_jobs(db: AsyncSession = Depends(get_db)):
    """Return all pipeline jobs ordered newest-first."""
    result = await db.execute(
        select(PipelineJob)
        .where(PipelineJob.job_type == "draft_class")
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
# GET /pipeline/jobs/{job_id}
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str, db: AsyncSession = Depends(get_db)):
    """Return the status of a single pipeline job."""
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


# ---------------------------------------------------------------------------
# DELETE /pipeline/jobs/{job_id}
# ---------------------------------------------------------------------------

@router.delete("/jobs/{job_id}", status_code=204)
async def cancel_job(job_id: str, db: AsyncSession = Depends(get_db)):
    """Cancel a queued or running pipeline job."""
    result = await db.execute(select(PipelineJob).where(PipelineJob.id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job.status = "cancelled"
    await db.commit()
