"""
backend/models/schemas/pipeline.py — Pydantic schemas for the pipeline endpoints.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class PipelineRunRequest(BaseModel):
    roster_file_id: Optional[str] = None
    model: str = "llama3:8b"
    prospects_count: int = 250
    skip_steps: list[int] = Field(default_factory=list)


class RosterPipelineRunRequest(BaseModel):
    roster_file_id: Optional[str] = None


class JobStatus(BaseModel):
    id: str
    job_type: str
    status: str
    current_step: int = 0
    total_steps: int = 6
    progress_pct: int = 0
    error_message: Optional[str] = None
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
