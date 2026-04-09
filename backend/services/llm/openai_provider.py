"""
backend/services/llm/openai_provider.py — OpenAI LLM provider.
"""
from __future__ import annotations

from typing import AsyncIterator

from backend.services.llm.base import LLMProvider


class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def _client(self):
        from openai import AsyncOpenAI  # lazy import
        return AsyncOpenAI(api_key=self._api_key)

    async def complete(self, prompt: str, *, model: str, temperature: float = 0.2) -> str:
        client = self._client()
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        )
        return response.choices[0].message.content or ""

    async def stream(self, prompt: str, *, model: str) -> AsyncIterator[str]:
        client = self._client()
        async with client.chat.completions.stream(
            model=model,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def list_models(self) -> list[str]:
        client = self._client()
        models = await client.models.list()
        return [m.id for m in models.data]

    async def health_check(self) -> bool:
        try:
            await self.list_models()
            return True
        except Exception:
            return False
