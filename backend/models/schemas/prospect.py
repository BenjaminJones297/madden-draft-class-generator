"""
backend/models/schemas/prospect.py — Pydantic schemas for prospects.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ProspectBase(BaseModel):
    draft_year: Optional[int] = None
    name: str
    position: Optional[str] = None
    school: Optional[str] = None
    draft_round: Optional[int] = None
    draft_pick: Optional[int] = None
    height: Optional[str] = None
    weight: Optional[int] = None
    forty_time: Optional[float] = None
    bench: Optional[int] = None
    vertical: Optional[float] = None
    broad_jump: Optional[int] = None
    three_cone: Optional[float] = None
    shuttle: Optional[float] = None
    draft_grade: Optional[float] = None
    board_rank: Optional[int] = None
    source: Optional[str] = None


class ProspectResponse(ProspectBase):
    id: str
    created_at: datetime

    model_config = {"from_attributes": True}


class ProspectRatingResponse(BaseModel):
    id: str
    prospect_id: str
    draft_class_id: Optional[str] = None
    llm_provider: Optional[str] = None
    generated_at: Optional[datetime] = None
    is_manual: bool = False
    overall: Optional[int] = None
    speed: Optional[int] = None
    acceleration: Optional[int] = None
    agility: Optional[int] = None
    strength: Optional[int] = None
    awareness: Optional[int] = None
    throw_power: Optional[int] = None
    throw_accuracy: Optional[int] = None
    dev_trait: Optional[str] = None
    raw_llm_output: Optional[dict] = None
    prompt_hash: Optional[str] = None

    model_config = {"from_attributes": True}
