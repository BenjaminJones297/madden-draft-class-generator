"""
backend/routers/prospects.py — Prospect read/write endpoints.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.session import get_db
from backend.models.db.models import Prospect
from backend.models.schemas.prospect import ProspectBase, ProspectResponse

router = APIRouter(prefix="/prospects", tags=["prospects"])


# ---------------------------------------------------------------------------
# GET /prospects/
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[ProspectResponse])
async def list_prospects(
    year: Optional[int] = Query(None),
    position: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List prospects with optional filters."""
    stmt = select(Prospect)
    if year is not None:
        stmt = stmt.where(Prospect.draft_year == year)
    if position is not None:
        stmt = stmt.where(Prospect.position == position)
    stmt = stmt.order_by(Prospect.board_rank).limit(limit).offset(offset)
    result = await db.execute(stmt)
    return result.scalars().all()


# ---------------------------------------------------------------------------
# GET /prospects/{prospect_id}
# ---------------------------------------------------------------------------

@router.get("/{prospect_id}", response_model=ProspectResponse)
async def get_prospect(prospect_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Prospect).where(Prospect.id == prospect_id))
    prospect = result.scalar_one_or_none()
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect not found")
    return prospect


# ---------------------------------------------------------------------------
# PATCH /prospects/{prospect_id}
# ---------------------------------------------------------------------------

@router.patch("/{prospect_id}", response_model=ProspectResponse)
async def update_prospect(
    prospect_id: str,
    data: ProspectBase,
    db: AsyncSession = Depends(get_db),
):
    """Update prospect fields (e.g. manual rating override)."""
    result = await db.execute(select(Prospect).where(Prospect.id == prospect_id))
    prospect = result.scalar_one_or_none()
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(prospect, field, value)
    await db.commit()
    await db.refresh(prospect)
    return prospect


# ---------------------------------------------------------------------------
# POST /prospects/{prospect_id}/regenerate
# ---------------------------------------------------------------------------

@router.post("/{prospect_id}/regenerate", status_code=202)
async def regenerate_prospect(
    prospect_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Re-run the LLM rating generation for a single prospect."""
    result = await db.execute(select(Prospect).where(Prospect.id == prospect_id))
    prospect = result.scalar_one_or_none()
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect not found")
    # TODO: enqueue single-prospect regeneration task
    return {"detail": "Regeneration queued", "prospect_id": prospect_id}
