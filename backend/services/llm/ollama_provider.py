"""
backend/services/llm/ollama_provider.py — Ollama LLM provider.
"""
from __future__ import annotations

from typing import AsyncIterator

from backend.services.llm.base import LLMProvider


class OllamaProvider(LLMProvider):
    def __init__(self, host: str = "http://localhost:11434") -> None:
        self._host = host

    def _client(self):
        import ollama  # lazy import so missing package doesn't break startup
        return ollama.AsyncClient(host=self._host)

    async def complete(self, prompt: str, *, model: str, temperature: float = 0.2) -> str:
        client = self._client()
        response = await client.generate(
            model=model,
            prompt=prompt,
            options={"temperature": temperature},
        )
        return response["response"]

    async def stream(self, prompt: str, *, model: str) -> AsyncIterator[str]:
        client = self._client()
        async for chunk in await client.generate(
            model=model,
            prompt=prompt,
            stream=True,
        ):
            yield chunk.get("response", "")

    async def list_models(self) -> list[str]:
        client = self._client()
        result = await client.list()
        return [m["name"] for m in result.get("models", [])]

    async def health_check(self) -> bool:
        try:
            client = self._client()
            await client.list()
            return True
        except Exception:
            return False
