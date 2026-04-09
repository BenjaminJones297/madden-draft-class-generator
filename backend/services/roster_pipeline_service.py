"""
backend/services/roster_pipeline_service.py — Roster pipeline orchestration.

Mirrors roster_run.py logic but runs inside an ARQ worker:
  Step 7 — scripts/7_fetch_nfl_roster_and_contracts.py  (Python)
  Step 3 — scripts/3_extract_roster_ratings.js          (Node / sidecar)
  Step 8 — scripts/8_generate_roster_ratings.py         (Python)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sqlalchemy import select

from backend.config import settings
from backend.db.session import AsyncSessionLocal
from backend.models.db.models import PipelineJob

PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)


# ---------------------------------------------------------------------------
# Helpers (shared pattern with pipeline_service)
# ---------------------------------------------------------------------------

async def _publish(redis_client, job_id: str, payload: dict) -> None:
    channel = f"job:{job_id}:channel"
    try:
        await redis_client.publish(channel, json.dumps(payload))
    except Exception:
        pass


async def _update_job(
    job_id: str,
    *,
    status: str | None = None,
    current_step: int | None = None,
    progress_pct: int | None = None,
    error_message: str | None = None,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
) -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(PipelineJob).where(PipelineJob.id == job_id))
        job = result.scalar_one_or_none()
        if job is None:
            return
        if status is not None:
            job.status = status
        if current_step is not None:
            job.current_step = current_step
        if progress_pct is not None:
            job.progress_pct = progress_pct
        if error_message is not None:
            job.error_message = error_message
        if started_at is not None:
            job.started_at = started_at
        if completed_at is not None:
            job.completed_at = completed_at
        await db.commit()


async def _run_subprocess(cmd: list[str]) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=PROJECT_ROOT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode("utf-8", errors="replace") if stdout else ""
    return proc.returncode or 0, output


async def _call_sidecar(endpoint: str, payload: dict) -> dict:
    url = f"{settings.NODE_SIDECAR_URL}{endpoint}"
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

async def run_roster_pipeline(job_id: str, config: dict) -> None:
    """
    Execute the 3-step roster pipeline (steps 7 → 3 → 8).

    config keys:
        roster_file_id – StoredFile id of the .ros file (optional)
    """
    try:
        import redis.asyncio as aioredis
    except ImportError:
        aioredis = None  # type: ignore[assignment]

    redis_client = None
    if aioredis is not None:
        try:
            redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        except Exception:
            redis_client = None

    async def publish(payload: dict) -> None:
        if redis_client:
            await _publish(redis_client, job_id, payload)

    roster_file_id: str | None = config.get("roster_file_id")
    python = sys.executable
    scripts = os.path.join(PROJECT_ROOT, "scripts")
    TOTAL = 3  # logical steps in this pipeline

    await _update_job(
        job_id,
        status="running",
        started_at=datetime.now(timezone.utc),
        current_step=0,
        progress_pct=0,
    )
    await publish({"type": "step_start", "step": 0, "total": TOTAL})

    # ── Resolve roster file path ───────────────────────────────────────────
    ros_path: str | None = None
    if roster_file_id:
        storage_root = Path(settings.STORAGE_LOCAL_PATH)
        matches = list(storage_root.glob(f"{roster_file_id}*"))
        if matches:
            ros_path = str(matches[0])

    ordered_steps = [
        (7, "Fetch current NFL roster & contract data"),
        (3, "Extract official Madden ratings from .ros file"),
        (8, "Merge official ratings + contract data"),
    ]

    for logical_idx, (step_num, description) in enumerate(ordered_steps, start=1):
        await publish({"type": "step_start", "step": step_num, "description": description})
        await _update_job(
            job_id,
            current_step=logical_idx,
            progress_pct=int((logical_idx - 1) / TOTAL * 100),
        )

        try:
            if step_num == 7:
                cmd = [python, os.path.join(scripts, "7_fetch_nfl_roster_and_contracts.py")]
                rc, out = await _run_subprocess(cmd)

            elif step_num == 3:
                if not ros_path:
                    await publish({"type": "log", "step": 3, "message": "Step 3 skipped — no .ros file"})
                    continue
                try:
                    result = await _call_sidecar(
                        "/read-roster", {"file_path": ros_path}
                    )
                    rc, out = 0, json.dumps(result)
                except httpx.HTTPError:
                    import shutil
                    node = shutil.which("node") or "node"
                    cmd = [node, os.path.join(scripts, "3_extract_roster_ratings.js"), "--ros", ros_path]
                    rc, out = await _run_subprocess(cmd)

            elif step_num == 8:
                cmd = [python, os.path.join(scripts, "8_generate_roster_ratings.py")]
                rc, out = await _run_subprocess(cmd)

            else:
                rc, out = 0, ""

        except Exception as exc:
            rc, out = 1, str(exc)

        await publish({"type": "log", "step": step_num, "message": out[-2000:]})

        if rc != 0:
            error_msg = f"Step {step_num} failed (exit {rc}): {out[-500:]}"
            await _update_job(
                job_id,
                status="failed",
                error_message=error_msg,
                completed_at=datetime.now(timezone.utc),
            )
            await publish({"type": "job_failed", "step": step_num, "error_message": error_msg})
            if redis_client:
                await redis_client.aclose()
            return

        await publish(
            {
                "type": "step_complete",
                "step": step_num,
                "progress_pct": int(logical_idx / TOTAL * 100),
            }
        )

    # ── Done ─────────────────────────────────────────────────────────────────
    await _update_job(
        job_id,
        status="completed",
        current_step=TOTAL,
        progress_pct=100,
        completed_at=datetime.now(timezone.utc),
    )
    await publish({"type": "job_complete", "progress_pct": 100})

    if redis_client:
        await redis_client.aclose()
