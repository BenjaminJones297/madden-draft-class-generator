"""
backend/services/pipeline_service.py — Draft-class pipeline orchestration.

Mirrors the logic in run.py but:
  - Runs inside an ARQ worker (async)
  - Updates PipelineJob progress in the DB after each step
  - Publishes progress events to the Redis channel  job:<job_id>:channel
  - Calls Python scripts via subprocess (keeps them fully isolated)
  - Calls Node.js scripts via the Node sidecar HTTP API
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

# Project root = backend/../
PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)


# ---------------------------------------------------------------------------
# Redis pub/sub helper
# ---------------------------------------------------------------------------

async def _publish(redis_client, job_id: str, payload: dict) -> None:
    """Publish a JSON event to the job's Redis channel."""
    channel = f"job:{job_id}:channel"
    try:
        await redis_client.publish(channel, json.dumps(payload))
    except Exception:
        pass  # Publishing failures must never abort the pipeline


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Subprocess runner
# ---------------------------------------------------------------------------

async def _run_subprocess(cmd: list[str]) -> tuple[int, str]:
    """Run a subprocess and return (returncode, combined_output)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=PROJECT_ROOT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode("utf-8", errors="replace") if stdout else ""
    return proc.returncode or 0, output


# ---------------------------------------------------------------------------
# Node sidecar helper
# ---------------------------------------------------------------------------

async def _call_sidecar(endpoint: str, payload: dict) -> dict:
    """Call the Node.js sidecar and return the JSON response."""
    url = f"{settings.NODE_SIDECAR_URL}{endpoint}"
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

async def run_pipeline(job_id: str, config: dict) -> None:
    """
    Execute the full 6-step draft-class pipeline for a given job.

    config keys (all optional):
        roster_file_id  – StoredFile id of a .ros file to pass to step 3
        model           – Ollama model name (default: llama3:8b)
        prospects_count – max prospects to rate (default: 250)
        skip_steps      – list of step numbers to skip
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

    skip_steps: list[int] = config.get("skip_steps", [])
    model: str = config.get("model", settings.OLLAMA_MODEL)
    prospects_count: int = config.get("prospects_count", settings.NUM_PROSPECTS)
    roster_file_id: str | None = config.get("roster_file_id")

    python = sys.executable
    scripts = os.path.join(PROJECT_ROOT, "scripts")
    TOTAL = 6

    await _update_job(
        job_id,
        status="running",
        started_at=datetime.now(timezone.utc),
        current_step=0,
        progress_pct=0,
    )
    await publish({"type": "step_start", "step": 0, "total": TOTAL})

    # ── Resolve roster file path (needed by step 3) ───────────────────────────
    ros_path: str | None = None
    if roster_file_id:
        storage_root = Path(settings.STORAGE_LOCAL_PATH)
        # Try to find the file by roster_file_id prefix
        matches = list(storage_root.glob(f"{roster_file_id}*"))
        if matches:
            ros_path = str(matches[0])

    steps = [
        # (step_num, description, callable)
        (1, "Fetch nflverse combine & draft-picks CSVs", None),
        (2, "Extract M26 2025 calibration set (Node)", None),
        (3, "Extract current roster ratings (Node)", None),
        (4, "Fetch 2026 NFL draft prospects", None),
        (5, f"Generate ratings via Ollama ({model})", None),
        (6, "Write .draftclass file (Node)", None),
    ]

    for step_num, description, _ in steps:
        if step_num in skip_steps:
            await publish(
                {"type": "log", "step": step_num, "message": f"Step {step_num} skipped"}
            )
            continue

        await publish({"type": "step_start", "step": step_num, "description": description})
        await _update_job(job_id, current_step=step_num, progress_pct=int((step_num - 1) / TOTAL * 100))

        try:
            if step_num == 1:
                cmd = [python, os.path.join(scripts, "1_fetch_combine_and_picks.py")]
                rc, out = await _run_subprocess(cmd)

            elif step_num == 2:
                try:
                    result = await _call_sidecar("/scripts/extract-calibration", {})
                    rc, out = 0, json.dumps(result)
                except httpx.HTTPError as exc:
                    # Fallback: run node directly
                    import shutil
                    node = shutil.which("node") or "node"
                    cmd = [node, os.path.join(scripts, "2_extract_calibration.js")]
                    rc, out = await _run_subprocess(cmd)

            elif step_num == 3:
                if not ros_path:
                    await publish({"type": "log", "step": 3, "message": "Step 3 skipped — no roster file"})
                    continue
                try:
                    result = await _call_sidecar(
                        "/scripts/extract-roster-ratings", {"ros_path": ros_path}
                    )
                    rc, out = 0, json.dumps(result)
                except httpx.HTTPError:
                    import shutil
                    node = shutil.which("node") or "node"
                    cmd = [node, os.path.join(scripts, "3_extract_roster_ratings.js"), "--ros", ros_path]
                    rc, out = await _run_subprocess(cmd)

            elif step_num == 4:
                cmd = [python, os.path.join(scripts, "4_fetch_2026_prospects.py")]
                rc, out = await _run_subprocess(cmd)

            elif step_num == 5:
                cmd = [
                    python,
                    os.path.join(scripts, "5_generate_ratings.py"),
                    "--model", model,
                    "--prospects", str(prospects_count),
                ]
                rc, out = await _run_subprocess(cmd)

            elif step_num == 6:
                output_dir = os.path.join(PROJECT_ROOT, "data", "output")
                os.makedirs(output_dir, exist_ok=True)
                out_file = os.path.join(output_dir, "2026_draft_class.draftclass")
                try:
                    result = await _call_sidecar(
                        "/scripts/create-draft-class", {"out": out_file}
                    )
                    rc, out = 0, json.dumps(result)
                except httpx.HTTPError:
                    import shutil
                    node = shutil.which("node") or "node"
                    cmd = [
                        node,
                        os.path.join(scripts, "6_create_draft_class.js"),
                        "--out", out_file,
                    ]
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
                "progress_pct": int(step_num / TOTAL * 100),
            }
        )

    # ── Pipeline finished ────────────────────────────────────────────────────
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
