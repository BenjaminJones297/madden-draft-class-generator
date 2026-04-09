"""
backend/services/llm/base.py — Abstract base class for all LLM providers.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator


class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, prompt: str, *, model: str, temperature: float = 0.2) -> str:
        """Return the full completion as a string."""

    @abstractmethod
    async def stream(self, prompt: str, *, model: str) -> AsyncIterator[str]:
        """Stream tokens as they arrive."""

    @abstractmethod
    async def list_models(self) -> list[str]:
        """Return available model names."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Return True if the provider is reachable."""
