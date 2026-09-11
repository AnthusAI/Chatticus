"""Behave steps for the deployment model catalog and per-turn selection."""

from __future__ import annotations

from dataclasses import replace

from behave import given, then, when
from browser_auth_helpers import wire_test_http_front_door

from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.llm.catalog import (
    VENDOR_ANTHROPIC,
    VENDOR_BEDROCK,
    VENDOR_GOOGLE,
    VENDOR_OPENAI,
    DeploymentCredentials,
    catalog_from_credentials,
)
from chatticus.worker.computerless import ComputerlessWorker, FakeTextCompletionClient


def _credentials(context: object) -> DeploymentCredentials:
    existing = getattr(context, "deployment_credentials", None)
    if existing is None:
        existing = DeploymentCredentials()
        context.deployment_credentials = existing
    return existing


def _apply_catalog(context: object) -> None:
    context.plane.model_catalog = catalog_from_credentials(_credentials(context))


@given("the deployment has Bedrock enabled")
def given_bedrock_enabled(context: object) -> None:
    context.deployment_credentials = replace(
        _credentials(context), bedrock_enabled=True
    )
    _apply_catalog(context)


@given("the deployment has OpenAI credentials")
def given_openai_credentials(context: object) -> None:
    context.deployment_credentials = replace(
        _credentials(context), openai_api_key="sk-test-openai"
    )
    _apply_catalog(context)


@given("the deployment has Anthropic credentials")
def given_anthropic_credentials(context: object) -> None:
    context.deployment_credentials = replace(
        _credentials(context), anthropic_api_key="sk-test-anthropic"
    )
    _apply_catalog(context)


@given("the deployment has Google credentials")
def given_google_credentials(context: object) -> None:
    context.deployment_credentials = replace(
        _credentials(context), google_api_key="test-google"
    )
    _apply_catalog(context)


@given("the deployment has no OpenAI, Anthropic, or Google credentials")
def given_no_vendor_api_keys(context: object) -> None:
    context.deployment_credentials = replace(
        _credentials(context),
        openai_api_key="",
        anthropic_api_key="",
        google_api_key="",
    )
    _apply_catalog(context)


@given("the deployment has no Bedrock, Anthropic, or Google credentials")
def given_no_bedrock_anthropic_google(context: object) -> None:
    context.deployment_credentials = replace(
        _credentials(context),
        bedrock_enabled=False,
        anthropic_api_key="",
        google_api_key="",
    )
    _apply_catalog(context)


@when("a member lists available models")
def when_member_lists_models(context: object) -> None:
    response = context.api_client.get(org_path("anthus", "/models"))
    assert response.status_code == 200, response.text
    context.catalog_payload = response.json()


@then("the catalog contains only Bedrock models")
def then_catalog_only_bedrock(context: object) -> None:
    vendors = {item["vendor"] for item in context.catalog_payload["models"]}
    assert vendors == {VENDOR_BEDROCK}, context.catalog_payload
    assert context.catalog_payload["models"], context.catalog_payload


@then("the default model is a Bedrock model")
def then_default_is_bedrock(context: object) -> None:
    default_id = context.catalog_payload["default_model_id"]
    match = next(
        item
        for item in context.catalog_payload["models"]
        if item["model_id"] == default_id
    )
    assert match["vendor"] == VENDOR_BEDROCK, match


@then("the catalog contains OpenAI models")
def then_catalog_has_openai(context: object) -> None:
    vendors = {item["vendor"] for item in context.catalog_payload["models"]}
    assert VENDOR_OPENAI in vendors, context.catalog_payload


@then("the catalog contains Bedrock models")
def then_catalog_has_bedrock(context: object) -> None:
    vendors = {item["vendor"] for item in context.catalog_payload["models"]}
    assert VENDOR_BEDROCK in vendors, context.catalog_payload


@then("the catalog contains OpenAI, Bedrock, Anthropic, and Google models")
def then_catalog_has_all_vendors(context: object) -> None:
    vendors = {item["vendor"] for item in context.catalog_payload["models"]}
    assert vendors == {
        VENDOR_OPENAI,
        VENDOR_BEDROCK,
        VENDOR_ANTHROPIC,
        VENDOR_GOOGLE,
    }, context.catalog_payload


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts "{body}" '
    'addressed to bot "{name}" on the channel using model "{model_id}"'
)
def when_human_posts_with_model(
    context: object,
    user_id: str,
    tenant_id: str,
    body: str,
    name: str,
    model_id: str,
) -> None:
    channel = context.last_channel
    bot = context.bots_by_name[name]
    response = context.api_client.post(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": "human",
            "author_id": user_id,
            "body": body,
            "addressed_to_bot_id": bot.bot_id,
            "model_id": model_id,
        },
    )
    context.message_post_response = response
    if response.status_code == 200:
        context.message_error = None
        context.last_turn_id = response.json().get("turn_id")
        return
    context.message_error = response.json().get("detail", response.text)


@then('the turn records model "{model_id}"')
def then_turn_records_model(context: object, model_id: str) -> None:
    assert context.last_turn_id is not None
    turn = context.plane.turn(context.last_channel.tenant_id, context.last_turn_id)
    assert turn.model_id == model_id, turn.model_id


@then("the turn records the deployment default model")
def then_turn_records_default_model(context: object) -> None:
    assert context.last_turn_id is not None
    turn = context.plane.turn(context.last_channel.tenant_id, context.last_turn_id)
    default = context.plane.model_catalog.default()
    assert default is not None
    assert turn.model_id == default.model_id, turn.model_id


@then("posting fails because the model is not available")
def then_posting_fails_unavailable_model(context: object) -> None:
    response = context.message_post_response
    assert response.status_code == 400, response.text
    assert "not available" in str(context.message_error).lower(), context.message_error


@when('bot "{bot_name}" runs one computerless worker turn for the selected model')
def when_worker_runs_selected_model(context: object, bot_name: str) -> None:
    bot = context.bots_by_name[bot_name]
    turn = context.plane.turn(bot.tenant_id, context.last_turn_id)
    assert turn.model_id is not None
    option = context.plane.model_catalog.get(turn.model_id)
    wire_test_http_front_door(context, context.plane, invoke_key="")
    worker = ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, bot.tenant_id),
        FakeTextCompletionClient(
            model=option.provider_model,
            vendor=option.vendor,
            billed_via=option.billed_via,
        ),
    )
    worker.complete_pending_for_bot(bot.bot_id)
