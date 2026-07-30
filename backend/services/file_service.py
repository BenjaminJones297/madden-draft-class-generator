"""
backend/services/file_service.py — File storage service.

Saves uploaded files to STORAGE_LOCAL_PATH, manages StoredFile DB records,
and provides helpers for download and deletion.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.models.db.models import StoredFile


def _storage_root() -> Path:
    """Return (and create if necessary) the local storage root directory."""
    root = Path(settings.STORAGE_LOCAL_PATH)
    root.mkdir(parents=True, exist_ok=True)
    return root


async def save_upload(file: UploadFile, db: AsyncSession) -> StoredFile:
    """
    Persist an uploaded file to disk and create a StoredFile row in the DB.

    Returns the newly created StoredFile ORM instance.
    """
    file_id = str(uuid.uuid4())
    original_name = file.filename or "upload"
    # Preserve extension so Node sidecar / consumers can infer type
    ext = Path(original_name).suffix
    storage_key = f"{file_id}{ext}"

    dest_path = _storage_root() / storage_key

    size = 0
    async with aiofiles.open(dest_path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 256)  # 256 KB chunks
            if not chunk:
                break
            await out.write(chunk)
            size += len(chunk)

    stored = StoredFile(
        id=file_id,
        original_name=original_name,
        storage_key=storage_key,
        storage_backend=settings.STORAGE_BACKEND,
        content_type=file.content_type,
        size_bytes=size,
        uploaded_at=datetime.now(timezone.utc),
    )
    db.add(stored)
    await db.commit()
    await db.refresh(stored)
    return stored


async def get_file_path(file_id: str, db: AsyncSession) -> str:
    """
    Return the absolute filesystem path for a stored file.

    Raises HTTP 404 if the record or the file does not exist.
    """
    result = await db.execute(select(StoredFile).where(StoredFile.id == file_id))
    stored = result.scalar_one_or_none()
    if stored is None:
        raise HTTPException(status_code=404, detail="File not found")

    path = _storage_root() / stored.storage_key
    if not path.exists():
        raise HTTPException(status_code=404, detail="File data not found on disk")

    return str(path)


async def delete_stored_file(file_id: str, db: AsyncSession) -> None:
    """
    Delete a file from disk and remove its DB record.

    Raises HTTP 404 if the record does not exist.
    """
    result = await db.execute(select(StoredFile).where(StoredFile.id == file_id))
    stored = result.scalar_one_or_none()
    if stored is None:
        raise HTTPException(status_code=404, detail="File not found")

    path = _storage_root() / stored.storage_key
    if path.exists():
        path.unlink(missing_ok=True)

    await db.delete(stored)
    await db.commit()
