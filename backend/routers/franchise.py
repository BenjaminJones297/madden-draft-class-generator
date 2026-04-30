"""
backend/routers/franchise.py — Franchise management + AI advisor endpoints.
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
from backend.models.db.models import Franchise

router = APIRouter(prefix="/franchise", tags=["franchise"])


# ── Request/response helpers ──────────────────────────────────────────────────

class FranchiseCreate(BaseModel):
    name: str
    team: str | None = None
    madden_version: str = "26"
    current_year: int | None = None
    roster_id: str | None = None
    settings: dict | None = None


class FranchiseResponse(BaseModel):
    id: str
    name: str
    team: str | None = None
    madden_version: str
    current_week: int
    current_year: int | None = None
    roster_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class TradeAnalyzerRequest(BaseModel):
    offering: list[dict]
    receiving: list[dict]


class DraftBoardRequest(BaseModel):
    draft_class_id: str | None = None
    needs: list[str] | None = None


class DepthChartRequest(BaseModel):
    position: str | None = None


# ---------------------------------------------------------------------------
# GET /franchise/
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[FranchiseResponse])
async def list_franchises(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Franchise).order_by(Franchise.created_at.desc())
    )
    return result.scalars().all()


# ---------------------------------------------------------------------------
# POST /franchise/
# ---------------------------------------------------------------------------

@router.post("/", response_model=FranchiseResponse, status_code=201)
async def create_franchise(
    payload: FranchiseCreate,
    db: AsyncSession = Depends(get_db),
):
    franchise = Franchise(
        id=str(uuid.uuid4()),
        name=payload.name,
        team=payload.team,
        madden_version=payload.madden_version,
        current_week=1,
        current_year=payload.current_year,
        roster_id=payload.roster_id,
        settings=payload.settings,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(franchise)
    await db.commit()
    await db.refresh(franchise)
    return franchise


# ---------------------------------------------------------------------------
# GET /franchise/{franchise_id}/advice
# ---------------------------------------------------------------------------

@router.get("/{franchise_id}/advice")
async def get_advice(franchise_id: str, db: AsyncSession = Depends(get_db)):
    """Return AI-generated franchise advice."""
    result = await db.execute(select(Franchise).where(Franchise.id == franchise_id))
    franchise = result.scalar_one_or_none()
    if franchise is None:
        raise HTTPException(status_code=404, detail="Franchise not found")
    # TODO: call LLM advisor service
    return {
        "franchise_id": franchise_id,
        "advice": "AI advisor not yet implemented — check back after LLM integration.",
    }


# ---------------------------------------------------------------------------
# POST /franchise/{franchise_id}/trade-analyzer
# ---------------------------------------------------------------------------

@router.post("/{franchise_id}/trade-analyzer")
async def analyze_trade(
    franchise_id: str,
    payload: TradeAnalyzerRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Franchise).where(Franchise.id == franchise_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Franchise not found")
    # TODO: call LLM trade analysis
    return {
        "franchise_id": franchise_id,
        "verdict": "pending",
        "analysis": "Trade analyzer not yet implemented.",
    }


# ---------------------------------------------------------------------------
# POST /franchise/{franchise_id}/draft-board
# ---------------------------------------------------------------------------

@router.post("/{franchise_id}/draft-board")
async def generate_draft_board(
    franchise_id: str,
    payload: DraftBoardRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Franchise).where(Franchise.id == franchise_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Franchise not found")
    # TODO: rank prospects vs team needs
    return {"franchise_id": franchise_id, "draft_board": []}


# ---------------------------------------------------------------------------
# GET /franchise/{franchise_id}/cap
# ---------------------------------------------------------------------------

@router.get("/{franchise_id}/cap")
async def cap_analysis(franchise_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Franchise).where(Franchise.id == franchise_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Franchise not found")
    # TODO: sum cap hits from roster
    return {"franchise_id": franchise_id, "total_cap_hit": None, "cap_space": None}


# ---------------------------------------------------------------------------
# POST /franchise/{franchise_id}/depth-chart
# ---------------------------------------------------------------------------

@router.post("/{franchise_id}/depth-chart")
async def suggest_depth_chart(
    franchise_id: str,
    payload: DepthChartRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Franchise).where(Franchise.id == franchise_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Franchise not found")
    # TODO: call LLM depth chart advisor
    return {"franchise_id": franchise_id, "depth_chart": {}}
