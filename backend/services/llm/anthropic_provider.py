"""
backend/services/llm/anthropic_provider.py — Anthropic LLM provider.
"""
from __future__ import annotations

from typing import AsyncIterator

from backend.services.llm.base import LLMProvider


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def _client(self):
        from anthropic import AsyncAnthropic  # lazy import
        return AsyncAnthropic(api_key=self._api_key)

    async def complete(self, prompt: str, *, model: str, temperature: float = 0.2) -> str:
        client = self._client()
        message = await client.messages.create(
            model=model,
            max_tokens=4096,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text if message.content else ""

    async def stream(self, prompt: str, *, model: str) -> AsyncIterator[str]:
        client = self._client()
        async with client.messages.stream(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def list_models(self) -> list[str]:
        # Anthropic does not expose a list-models endpoint; return known models.
        return [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
        ]

    async def health_check(self) -> bool:
        try:
            client = self._client()
            # A lightweight call to verify the API key works
            await client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=1,
                messages=[{"role": "user", "content": "ping"}],
            )
            return True
        except Exception:
            return False
