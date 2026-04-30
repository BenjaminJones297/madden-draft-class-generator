"""
backend/routers/roster.py — Roster upload and player listing endpoints.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.session import get_db
from backend.models.db.models import Roster, RosterPlayer
from backend.services.file_service import save_upload

router = APIRouter(prefix="/roster", tags=["roster"])


# ---------------------------------------------------------------------------
# POST /roster/upload
# ---------------------------------------------------------------------------

@router.post("/upload", status_code=201)
async def upload_roster(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload a Madden .ros file and create a Roster record."""
    stored = await save_upload(file, db)
    roster = Roster(
        id=str(uuid.uuid4()),
        name=file.filename or "uploaded_roster",
        madden_version="26",
        source_file_id=stored.id,
        extracted_at=datetime.now(timezone.utc),
    )
    db.add(roster)
    await db.commit()
    await db.refresh(roster)
    return {"roster_id": roster.id, "file_id": stored.id, "name": roster.name}


# ---------------------------------------------------------------------------
# GET /roster/{roster_id}
# ---------------------------------------------------------------------------

@router.get("/{roster_id}")
async def get_roster(roster_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Roster).where(Roster.id == roster_id))
    roster = result.scalar_one_or_none()
    if roster is None:
        raise HTTPException(status_code=404, detail="Roster not found")
    return {
        "id": roster.id,
        "name": roster.name,
        "madden_version": roster.madden_version,
        "extracted_at": roster.extracted_at,
        "source_file_id": roster.source_file_id,
    }


# ---------------------------------------------------------------------------
# GET /roster/{roster_id}/players
# ---------------------------------------------------------------------------

@router.get("/{roster_id}/players")
async def list_roster_players(
    roster_id: str,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Roster).where(Roster.id == roster_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Roster not found")

    stmt = (
        select(RosterPlayer)
        .where(RosterPlayer.roster_id == roster_id)
        .order_by(RosterPlayer.overall.desc())
        .limit(limit)
        .offset(offset)
    )
    players_result = await db.execute(stmt)
    players = players_result.scalars().all()
    return [
        {
            "id": p.id,
            "first_name": p.first_name,
            "last_name": p.last_name,
            "position": p.position,
            "overall": p.overall,
            "age": p.age,
            "dev_trait": p.dev_trait,
            "contract_years": p.contract_years,
            "contract_salary": p.contract_salary,
            "cap_hit": p.cap_hit,
        }
        for p in players
    ]
