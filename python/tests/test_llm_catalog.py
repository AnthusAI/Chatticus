"""Deployment catalog filtering by credentials."""

from __future__ import annotations

import pytest

from chatticus.llm.catalog import (
    ANTHROPIC_CLAUDE_SONNET_ID,
    BEDROCK_CLAUDE_SONNET_ID,
    GOOGLE_GEMINI_FLASH_ID,
    OPENAI_GPT_56_LUNA_ID,
    DeploymentCredentials,
    catalog_from_credentials,
)
from chatticus.llm.credentials import credentials_from_env
from chatticus.llm.router import CatalogCompletionClient
from chatticus.llm.tools import (
    anthropic_tools,
    bedrock_tool_config,
    computerless_tool_specs,
    google_function_declarations,
    openai_function_tools,
)
from chatticus.models import UnknownModelError
from chatticus.vendor_ledger import BILLED_VIA_AWS


def test_aws_only_catalog_is_bedrock() -> None:
    catalog = catalog_from_credentials(DeploymentCredentials(bedrock_enabled=True))
    vendors = {option.vendor for option in catalog.available()}
    assert vendors == {"bedrock"}
    default = catalog.default()
    assert default is not None
    assert default.vendor == "bedrock"
    assert default.billed_via == BILLED_VIA_AWS


def test_openai_and_bedrock_catalog_offers_both() -> None:
    catalog = catalog_from_credentials(
        DeploymentCredentials(openai_api_key="sk-test", bedrock_enabled=True)
    )
    ids = {option.model_id for option in catalog.available()}
    assert OPENAI_GPT_56_LUNA_ID in ids
    assert BEDROCK_CLAUDE_SONNET_ID in ids
    assert catalog.default() is not None
    assert catalog.default().model_id == OPENAI_GPT_56_LUNA_ID


def test_kitchen_sink_catalog_offers_every_vendor() -> None:
    catalog = catalog_from_credentials(
        DeploymentCredentials(
            openai_api_key="sk-openai",
            anthropic_api_key="sk-anthropic",
            google_api_key="google",
            bedrock_enabled=True,
        )
    )
    ids = {option.model_id for option in catalog.available()}
    assert OPENAI_GPT_56_LUNA_ID in ids
    assert BEDROCK_CLAUDE_SONNET_ID in ids
    assert ANTHROPIC_CLAUDE_SONNET_ID in ids
    assert GOOGLE_GEMINI_FLASH_ID in ids


def test_empty_credentials_yield_an_empty_catalog() -> None:
    catalog = catalog_from_credentials(DeploymentCredentials())
    assert catalog.available() == ()
    assert catalog.default() is None


def test_resolve_rejects_unavailable_model() -> None:
    catalog = catalog_from_credentials(DeploymentCredentials(openai_api_key="sk-test"))
    with pytest.raises(UnknownModelError, match="not available"):
        catalog.resolve(ANTHROPIC_CLAUDE_SONNET_ID)


def test_vendor_tool_translations_share_canonical_names() -> None:
    names = {spec.name for spec in computerless_tool_specs()}
    assert names == {tool["function"]["name"] for tool in openai_function_tools()}
    assert names == {
        tool["toolSpec"]["name"] for tool in bedrock_tool_config()["tools"]
    }
    assert names == {tool["name"] for tool in anthropic_tools()}
    assert names == {tool["name"] for tool in google_function_declarations()}


def test_catalog_client_routes_bedrock_and_bills_aws() -> None:
    credentials = DeploymentCredentials(bedrock_enabled=True)
    catalog = catalog_from_credentials(credentials)

    def converse(**kwargs: object) -> dict[str, object]:
        assert kwargs["modelId"] == "anthropic.claude-sonnet-4-5"
        return {
            "output": {"message": {"content": [{"text": "Hello from Bedrock."}]}},
            "usage": {"inputTokens": 3, "outputTokens": 2},
        }

    client = CatalogCompletionClient(catalog, credentials, bedrock_converse=converse)
    outcome = client.complete("hi", model_id=BEDROCK_CLAUDE_SONNET_ID)
    assert outcome.text == "Hello from Bedrock."
    assert outcome.billed_via == BILLED_VIA_AWS
    assert outcome.usage.vendor == "bedrock"


def test_credentials_from_env_reads_vendor_keys_and_bedrock_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("chatticus.llm.credentials.load_local_env", lambda: None)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-anthropic")
    monkeypatch.setenv("GOOGLE_API_KEY", "google")
    monkeypatch.setenv("CHATTICUS_BEDROCK_ENABLED", "1")
    monkeypatch.delenv("OPENAI_API_KEY_PARAMETER", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY_PARAMETER", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY_PARAMETER", raising=False)
    credentials = credentials_from_env()
    assert credentials.openai_api_key == "sk-openai"
    assert credentials.anthropic_api_key == "sk-anthropic"
    assert credentials.google_api_key == "google"
    assert credentials.bedrock_enabled is True
