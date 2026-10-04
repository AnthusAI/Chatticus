"""Behavior steps for model provider failures in the computerless worker."""

from __future__ import annotations

import httpx
from behave import given, then, when
from worker_http_helpers import worker_auth_headers

from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.models import TurnStatus
from chatticus.worker.computerless import (
    CompletionOutcome,
    ComputerlessWorker,
)
from chatticus.worker.model_provider_errors import TemporaryModelProviderError


class FailingModelProviderClient:
    """A completion client whose provider answers every call with one error."""

    def __init__(self, status: int, code: str | None) -> None:
        self.status = status
        self.code = code
        self.calls = 0

    def complete(self, prompt: str) -> CompletionOutcome:
        self.calls += 1
        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        response = httpx.Response(
            self.status,
            request=request,
            json={
                "error": {"code": self.code, "message": f"Provider said {self.code}."}
            },
        )
        raise httpx.HTTPStatusError(
            f"Provider error {self.status}", request=request, response=response
        )


def _turn(context: object) -> object:
    channel = context.last_channel
    return context.plane.turn(channel.tenant_id, context.last_turn_id)


@given(
    "the model provider answers every request with status {status:d} "
    'and error code "{code}"'
)
def given_failing_model_provider(context: object, status: int, code: str) -> None:
    context.failing_provider = FailingModelProviderClient(status, code)


@given(
    "the model provider answers every request with status {status:d} and no error body"
)
def given_failing_model_provider_without_body(context: object, status: int) -> None:
    context.failing_provider = FailingModelProviderClient(status, None)


@when('bot "{name}" runs one computerless worker turn against that provider')
def when_worker_runs_against_failing_provider(context: object, name: str) -> None:
    channel = context.last_channel
    bot = context.bots_by_name[name]
    turn_client = HttpTurnClient(context.api_client, channel.tenant_id)
    worker = ComputerlessWorker(context.plane, turn_client, context.failing_provider)
    context.worker_error = None
    try:
        worker.complete_pending_for_bot(bot.bot_id)
    except TemporaryModelProviderError as error:
        context.worker_error = error


@then('the turn has failed with reason "{reason}"')
def then_turn_failed_with_reason(context: object, reason: str) -> None:
    turn = _turn(context)
    assert turn.status == TurnStatus.FAILED, turn.status
    assert turn.terminal_reason == reason, turn.terminal_reason


@then('user "{user_id}" receives a failed server-sent event with reason "{reason}"')
def then_receives_failed_event(context: object, user_id: str, reason: str) -> None:
    context.sse_watcher.wait_for_kind("turn.failed", timeout=5.0)
    failed = [
        event
        for event in context.sse_watcher.events
        if event.get("kind") == "turn.failed"
    ]
    assert len(failed) == 1, failed
    assert failed[0].get("body") == reason, failed[0]


@then("the model provider was called once")
def then_provider_called_once(context: object) -> None:
    assert context.failing_provider.calls == 1, context.failing_provider.calls


@then('no job for bot "{name}" is left to retry')
def then_no_job_left(context: object, name: str) -> None:
    bot = context.bots_by_name[name]
    assert list(context.plane.pending_jobs_for_bot(bot.bot_id)) == []


@then("the worker reports a temporary model provider failure")
def then_worker_reports_temporary_failure(context: object) -> None:
    assert isinstance(
        context.worker_error, TemporaryModelProviderError
    ), context.worker_error


@then("the turn is still active")
def then_turn_still_active(context: object) -> None:
    assert _turn(context).status == TurnStatus.ACTIVE


@then('a job for bot "{name}" is still queued for a retry')
def then_job_still_queued(context: object, name: str) -> None:
    bot = context.bots_by_name[name]
    assert len(list(context.plane.pending_jobs_for_bot(bot.bot_id))) == 1


@when("a worker reports the turn failed with a fence it does not hold")
def when_worker_reports_failure_with_wrong_fence(context: object) -> None:
    channel = context.last_channel
    context.failure_report_response = context.api_client.post(
        org_path(channel.tenant_id, f"/turns/{context.last_turn_id}/failed"),
        json={
            "reason": "The model provider rejected the API key.",
            "fence_token": context.fence_token + 1,
        },
        headers=worker_auth_headers(context, context.active_worker_id),
    )


@then("the failure report is rejected as stale")
def then_failure_report_rejected(context: object) -> None:
    response = context.failure_report_response
    assert response.status_code == 409, response.text
