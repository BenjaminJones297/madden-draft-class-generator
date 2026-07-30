"""
backend/routers/files.py — Generic file upload / download / delete endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse as FastAPIFileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.session import get_db
from backend.models.db.models import StoredFile
from backend.models.schemas.common import FileResponse
from backend.services.file_service import delete_stored_file, get_file_path, save_upload

router = APIRouter(prefix="/files", tags=["files"])


# ---------------------------------------------------------------------------
# POST /files/upload
# ---------------------------------------------------------------------------

@router.post("/upload", response_model=FileResponse, status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload any file and return a StoredFile record."""
    stored = await save_upload(file, db)
    return FileResponse(
        id=stored.id,
        original_name=stored.original_name,
        size_bytes=stored.size_bytes or 0,
        uploaded_at=stored.uploaded_at,
    )


# ---------------------------------------------------------------------------
# GET /files/{file_id}
# ---------------------------------------------------------------------------

@router.get("/{file_id}")
async def download_file(file_id: str, db: AsyncSession = Depends(get_db)):
    """Download a previously uploaded file."""
    result = await db.execute(select(StoredFile).where(StoredFile.id == file_id))
    stored = result.scalar_one_or_none()
    if stored is None:
        raise HTTPException(status_code=404, detail="File not found")

    file_path = await get_file_path(file_id, db)
    return FastAPIFileResponse(
        path=file_path,
        media_type=stored.content_type or "application/octet-stream",
        filename=stored.original_name,
    )


# ---------------------------------------------------------------------------
# DELETE /files/{file_id}
# ---------------------------------------------------------------------------

@router.delete("/{file_id}", status_code=204)
async def delete_file(file_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a stored file and its DB record."""
    await delete_stored_file(file_id, db)
