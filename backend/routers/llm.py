"""
backend/routers/llm.py — LLM provider management endpoints.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.session import get_db
from backend.models.db.models import LLMProviderConfig
from backend.services.llm.factory import get_provider

router = APIRouter(prefix="/llm", tags=["llm"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProviderCreate(BaseModel):
    name: str
    provider_type: str  # ollama | openai | anthropic
    base_url: str | None = None
    api_key_ref: str | None = None
    default_model: str | None = None
    is_active: bool = True
    config: dict | None = None


class ProviderResponse(BaseModel):
    id: str
    name: str
    provider_type: str
    base_url: str | None = None
    default_model: str | None = None
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class TestRequest(BaseModel):
    provider_type: str
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


# ---------------------------------------------------------------------------
# GET /llm/providers
# ---------------------------------------------------------------------------

@router.get("/providers", response_model=List[ProviderResponse])
async def list_providers(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(LLMProviderConfig).order_by(LLMProviderConfig.name)
    )
    return result.scalars().all()


# ---------------------------------------------------------------------------
# POST /llm/providers
# ---------------------------------------------------------------------------

@router.post("/providers", response_model=ProviderResponse, status_code=201)
async def upsert_provider(
    payload: ProviderCreate,
    db: AsyncSession = Depends(get_db),
):
    """Add a new provider or update an existing one (matched by name)."""
    result = await db.execute(
        select(LLMProviderConfig).where(LLMProviderConfig.name == payload.name)
    )
    existing = result.scalar_one_or_none()
    if existing:
        for field, value in payload.model_dump().items():
            setattr(existing, field, value)
        await db.commit()
        await db.refresh(existing)
        return existing

    provider = LLMProviderConfig(
        id=str(uuid.uuid4()),
        name=payload.name,
        provider_type=payload.provider_type,
        base_url=payload.base_url,
        api_key_ref=payload.api_key_ref,
        default_model=payload.default_model,
        is_active=payload.is_active,
        config=payload.config,
        created_at=datetime.now(timezone.utc),
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    return provider


# ---------------------------------------------------------------------------
# POST /llm/test
# ---------------------------------------------------------------------------

@router.post("/test")
async def test_provider(payload: TestRequest):
    """Test connectivity to an LLM provider."""
    cfg: dict = {"provider_type": payload.provider_type}
    if payload.base_url:
        cfg["base_url"] = payload.base_url
    if payload.api_key:
        cfg["api_key"] = payload.api_key

    try:
        provider = get_provider(cfg)
        healthy = await provider.health_check()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {"healthy": healthy}


# ---------------------------------------------------------------------------
# GET /llm/models
# ---------------------------------------------------------------------------

@router.get("/models")
async def list_models(
    provider_type: str = "ollama",
    base_url: str | None = None,
    api_key: str | None = None,
):
    """List available models for a given provider."""
    from backend.config import settings

    cfg: dict = {"provider_type": provider_type}
    if base_url:
        cfg["base_url"] = base_url
    elif provider_type == "ollama":
        cfg["base_url"] = settings.OLLAMA_HOST
    if api_key:
        cfg["api_key"] = api_key

    try:
        provider = get_provider(cfg)
        models = await provider.list_models()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {"models": models}
