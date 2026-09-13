"""Route one completion to the adapter that matches the selected model."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from chatticus.llm.catalog import (
    VENDOR_ANTHROPIC,
    VENDOR_BEDROCK,
    VENDOR_GOOGLE,
    VENDOR_OPENAI,
    DeploymentCredentials,
    ModelCatalog,
    ModelOption,
)
from chatticus.llm.types import CompletionOutcome


class CatalogCompletionClient:
    """Dispatch ``complete`` to the adapter named by the turn's model id."""

    def __init__(
        self,
        catalog: ModelCatalog,
        credentials: DeploymentCredentials,
        *,
        bedrock_converse: Callable[..., dict[str, Any]] | None = None,
    ) -> None:
        self.catalog = catalog
        self.credentials = credentials
        self._bedrock_converse = bedrock_converse

    def complete(
        self, prompt: str, *, model_id: str | None = None
    ) -> CompletionOutcome:
        """Call the adapter for ``model_id``, or the fake client when none apply."""
        option = self.catalog.resolve(model_id)
        if option is None:
            from chatticus.worker.computerless import FakeTextCompletionClient

            return FakeTextCompletionClient().complete(prompt)
        return self._client_for(option).complete(prompt, model_id=option.model_id)

    def _client_for(self, option: ModelOption) -> Any:
        if option.vendor == VENDOR_OPENAI:
            from chatticus.worker.openai_completion import OpenAITextCompletionClient

            return OpenAITextCompletionClient(
                self.credentials.openai_api_key, option.provider_model
            )
        if option.vendor == VENDOR_BEDROCK:
            from chatticus.llm.bedrock import BedrockTextCompletionClient

            return BedrockTextCompletionClient(
                option.provider_model,
                converse=self._bedrock_converse,
            )
        if option.vendor == VENDOR_ANTHROPIC:
            from chatticus.llm.anthropic import AnthropicTextCompletionClient

            return AnthropicTextCompletionClient(
                self.credentials.anthropic_api_key, option.provider_model
            )
        if option.vendor == VENDOR_GOOGLE:
            from chatticus.llm.google import GoogleTextCompletionClient

            return GoogleTextCompletionClient(
                self.credentials.google_api_key, option.provider_model
            )
        raise RuntimeError(f"Unsupported model vendor {option.vendor!r}.")
