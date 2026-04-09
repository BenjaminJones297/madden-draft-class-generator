"""
backend/config.py — Application settings via pydantic-settings.

All values can be overridden by environment variables or a .env file
placed at the project root.
"""
from __future__ import annotations

from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://madden:madden@localhost:5432/madden"

    # ── Redis / task queue ────────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379"

    # ── Node sidecar ─────────────────────────────────────────────────────────
    NODE_SIDECAR_URL: str = "http://localhost:3001"

    # ── LLM — Ollama ─────────────────────────────────────────────────────────
    OLLAMA_HOST: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "llama3:8b"

    # ── File storage ──────────────────────────────────────────────────────────
    STORAGE_BACKEND: str = "local"
    STORAGE_LOCAL_PATH: str = "./data/files"

    # ── Pipeline defaults ─────────────────────────────────────────────────────
    NUM_PROSPECTS: int = 250

    # ── External LLM API keys (optional) ─────────────────────────────────────
    OPENAI_API_KEY: Optional[str] = None
    ANTHROPIC_API_KEY: Optional[str] = None


# Singleton used throughout the application
settings = Settings()
