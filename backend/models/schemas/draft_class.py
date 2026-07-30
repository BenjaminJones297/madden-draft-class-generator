"""
backend/models/schemas/draft_class.py — Pydantic schemas for draft classes.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class DraftClassBase(BaseModel):
    name: str
    season_year: Optional[int] = None
    description: Optional[str] = None


class DraftClassCreate(DraftClassBase):
    pass


class DraftClassResponse(DraftClassBase):
    id: str
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}
