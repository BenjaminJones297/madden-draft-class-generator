"""
backend/routers/websocket.py — WebSocket endpoint that streams job progress.

Clients connect to  ws://<host>/ws/jobs/<job_id>
The server subscribes to the Redis pub/sub channel  job:<job_id>:channel
and forwards every message verbatim to the connected client.

Protocol message types (JSON):
  step_start    – a new pipeline step has started
  progress      – updated progress_pct
  step_complete – a step finished successfully
  log           – free-text log line from the worker
  job_complete  – the pipeline finished successfully
  job_failed    – the pipeline failed (includes error_message)
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.config import settings

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/jobs/{job_id}")
async def job_websocket(websocket: WebSocket, job_id: str):
    """Stream progress events for a pipeline job over WebSocket."""
    await websocket.accept()

    try:
        import redis.asyncio as aioredis
    except ImportError:
        await websocket.send_json(
            {"type": "error", "message": "Redis client not available"}
        )
        await websocket.close()
        return

    redis_client: aioredis.Redis | None = None
    pubsub = None
    try:
        redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        pubsub = redis_client.pubsub()
        channel = f"job:{job_id}:channel"
        await pubsub.subscribe(channel)

        async def _relay():
            async for raw in pubsub.listen():
                if raw["type"] != "message":
                    continue
                try:
                    payload = json.loads(raw["data"])
                except (json.JSONDecodeError, TypeError):
                    payload = {"type": "log", "message": str(raw["data"])}
                await websocket.send_json(payload)
                # Stop relaying once the job reaches a terminal state
                if payload.get("type") in ("job_complete", "job_failed"):
                    break

        relay_task = asyncio.create_task(_relay())

        # Keep the WebSocket open; cancel relay when the client disconnects
        try:
            while True:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        finally:
            relay_task.cancel()
            try:
                await relay_task
            except asyncio.CancelledError:
                pass

    except WebSocketDisconnect:
        pass
    finally:
        if pubsub is not None:
            await pubsub.unsubscribe()
            await pubsub.aclose()
        if redis_client is not None:
            await redis_client.aclose()
        try:
            await websocket.close()
        except Exception:
            pass
