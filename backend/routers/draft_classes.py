"""
backend/routers/draft_classes.py — Draft-class CRUD + export endpoints.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse as FastAPIFileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.db.session import get_db
from backend.models.db.models import DraftClass
from backend.models.schemas.draft_class import (
    DraftClassCreate,
    DraftClassResponse,
)

router = APIRouter(prefix="/draft-classes", tags=["draft-classes"])


def _to_response(dc: DraftClass) -> DraftClassResponse:
    return DraftClassResponse(
        id=dc.id,
        name=dc.name,
        season_year=dc.season_year,
        description=dc.description,
        status=dc.status,
        created_at=dc.created_at,
    )


# ---------------------------------------------------------------------------
# GET /draft-classes/
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[DraftClassResponse])
async def list_draft_classes(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(DraftClass).order_by(DraftClass.created_at.desc())
    )
    return [_to_response(dc) for dc in result.scalars().all()]


# ---------------------------------------------------------------------------
# POST /draft-classes/
# ---------------------------------------------------------------------------

@router.post("/", response_model=DraftClassResponse, status_code=201)
async def create_draft_class(
    payload: DraftClassCreate,
    db: AsyncSession = Depends(get_db),
):
    dc = DraftClass(
        id=str(uuid.uuid4()),
        name=payload.name,
        season_year=payload.season_year,
        description=payload.description,
        status="draft",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(dc)
    await db.commit()
    await db.refresh(dc)
    return _to_response(dc)


# ---------------------------------------------------------------------------
# GET /draft-classes/{draft_class_id}
# ---------------------------------------------------------------------------

@router.get("/{draft_class_id}", response_model=DraftClassResponse)
async def get_draft_class(draft_class_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(DraftClass).where(DraftClass.id == draft_class_id))
    dc = result.scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="Draft class not found")
    return _to_response(dc)


# ---------------------------------------------------------------------------
# PUT /draft-classes/{draft_class_id}
# ---------------------------------------------------------------------------

@router.put("/{draft_class_id}", response_model=DraftClassResponse)
async def update_draft_class(
    draft_class_id: str,
    payload: DraftClassCreate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(DraftClass).where(DraftClass.id == draft_class_id))
    dc = result.scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="Draft class not found")
    dc.name = payload.name
    dc.season_year = payload.season_year
    dc.description = payload.description
    dc.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(dc)
    return _to_response(dc)


# ---------------------------------------------------------------------------
# DELETE /draft-classes/{draft_class_id}
# ---------------------------------------------------------------------------

@router.delete("/{draft_class_id}", status_code=204)
async def delete_draft_class(draft_class_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(DraftClass).where(DraftClass.id == draft_class_id))
    dc = result.scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="Draft class not found")
    await db.delete(dc)
    await db.commit()


# ---------------------------------------------------------------------------
# POST /draft-classes/{draft_class_id}/export
# ---------------------------------------------------------------------------

@router.post("/{draft_class_id}/export", status_code=202)
async def export_draft_class(
    draft_class_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Trigger the Node sidecar to write a .draftclass binary file."""
    result = await db.execute(select(DraftClass).where(DraftClass.id == draft_class_id))
    dc = result.scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="Draft class not found")

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{settings.NODE_SIDECAR_URL}/export",
                json={"draft_class_id": draft_class_id},
            )
            resp.raise_for_status()
            sidecar_result = resp.json()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Node sidecar error: {exc}",
        )

    dc.status = "exported"
    dc.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"detail": "Export triggered", "sidecar_response": sidecar_result}


# ---------------------------------------------------------------------------
# GET /draft-classes/{draft_class_id}/download
# ---------------------------------------------------------------------------

@router.get("/{draft_class_id}/download")
async def download_draft_class(
    draft_class_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Stream the exported .draftclass binary back to the client."""
    result = await db.execute(select(DraftClass).where(DraftClass.id == draft_class_id))
    dc = result.scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="Draft class not found")
    if dc.exported_file_id is None:
        raise HTTPException(status_code=404, detail="Draft class has not been exported yet")

    from backend.services.file_service import get_file_path

    file_path = await get_file_path(dc.exported_file_id, db)
    return FastAPIFileResponse(
        path=file_path,
        media_type="application/octet-stream",
        filename=f"{dc.name}.draftclass",
    )
