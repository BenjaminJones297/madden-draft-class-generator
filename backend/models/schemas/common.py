"""
backend/models/schemas/common.py — Shared Pydantic schemas.
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class FileResponse(BaseModel):
    id: str
    original_name: str
    size_bytes: int
    uploaded_at: datetime

    model_config = {"from_attributes": True}
