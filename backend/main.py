"""
backend/main.py — FastAPI application factory.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import (
    draft_classes,
    files,
    franchise,
    llm,
    pipeline,
    prospects,
    roster,
    roster_pipeline,
    websocket,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup / shutdown logic."""
    # Future: create DB tables, warm connection pool, etc.
    yield
    # Future: close connection pool, flush caches, etc.


def create_app() -> FastAPI:
    app = FastAPI(
        title="Madden Franchise Manager API",
        version="1.0.0",
        description="REST API for the Madden Draft Class Generator & Franchise Manager",
        lifespan=lifespan,
    )

    # ── CORS (permissive for local dev) ───────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── REST routers ──────────────────────────────────────────────────────────
    prefix = "/api/v1"
    app.include_router(pipeline.router, prefix=prefix)
    app.include_router(roster_pipeline.router, prefix=prefix)
    app.include_router(prospects.router, prefix=prefix)
    app.include_router(draft_classes.router, prefix=prefix)
    app.include_router(roster.router, prefix=prefix)
    app.include_router(franchise.router, prefix=prefix)
    app.include_router(llm.router, prefix=prefix)
    app.include_router(files.router, prefix=prefix)

    # ── WebSocket router (no /api/v1 prefix — plain /ws path) ────────────────
    app.include_router(websocket.router)

    # ── Health check ─────────────────────────────────────────────────────────
    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
