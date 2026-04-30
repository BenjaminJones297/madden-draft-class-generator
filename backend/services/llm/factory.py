"""
backend/services/llm/factory.py — LLM provider factory.
"""
from __future__ import annotations

from backend.services.llm.base import LLMProvider


def get_provider(config: dict) -> LLMProvider:
    """Return the appropriate LLMProvider based on config['provider_type']."""
    from backend.services.llm.anthropic_provider import AnthropicProvider
    from backend.services.llm.ollama_provider import OllamaProvider
    from backend.services.llm.openai_provider import OpenAIProvider

    match config["provider_type"]:
        case "ollama":
            return OllamaProvider(host=config.get("base_url", "http://localhost:11434"))
        case "openai":
            return OpenAIProvider(api_key=config["api_key"])
        case "anthropic":
            return AnthropicProvider(api_key=config["api_key"])
        case _:
            raise ValueError(f"Unknown provider type: {config['provider_type']}")
