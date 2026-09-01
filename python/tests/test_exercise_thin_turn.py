"""Matchers used by the named-environment thin-turn exercise."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import httpx

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "exercise_thin_turn.py"
_SPEC = importlib.util.spec_from_file_location("exercise_thin_turn", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_EXERCISE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_EXERCISE)


def _response(status_code: int, body: object) -> httpx.Response:
    import json

    return httpx.Response(
        status_code,
        request=httpx.Request("GET", "https://example.test/probe"),
        content=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )


def test_task_http_routes_absent_for_unknown_path() -> None:
    assert _EXERCISE._task_http_routes_absent(_response(404, {"detail": "Not Found"}))


def test_task_http_routes_absent_rejects_domain_not_found() -> None:
    assert not _EXERCISE._task_http_routes_absent(
        _response(404, {"detail": "bot not found"})
    )


def test_task_http_required_when_development_live_flag_set(
    monkeypatch,
) -> None:
    monkeypatch.setenv("CHATTICUS_DEVELOPMENT_TASK_HTTP_LIVE", "1")
    assert _EXERCISE._task_http_required("development")
    assert not _EXERCISE._task_http_required("staging")


def test_computer_continuation_matches_this_job() -> None:
    body = {
        "job_id": "job-1",
        "turn_id": "turn-1",
        "required_capabilities": ["computer"],
    }
    assert _EXERCISE._computer_continuation_matches(
        body, job_id="job-1", turn_id="turn-1"
    )


def test_computer_continuation_rejects_a_stale_job() -> None:
    body = {
        "job_id": "old-job",
        "turn_id": "old-turn",
        "required_capabilities": ["computer"],
    }
    assert not _EXERCISE._computer_continuation_matches(
        body, job_id="job-1", turn_id="turn-1"
    )


def test_chromium_host_tool_result_body_requires_opened_prefix() -> None:
    events = [
        {"kind": "tool.result", "body": "opened"},
        {"kind": "tool.result", "body": "opened:about:blank"},
    ]
    assert _EXERCISE._chromium_host_tool_result_body(events) == "opened:about:blank"


def test_chromium_host_tool_result_body_rejects_fake_opened() -> None:
    events = [{"kind": "tool.result", "body": "opened"}]
    assert _EXERCISE._chromium_host_tool_result_body(events) is None


def test_grant_http_routes_absent_for_unknown_path() -> None:
    assert _EXERCISE._grant_http_routes_absent(_response(404, {"detail": "Not Found"}))


def test_grant_http_required_when_development_live_flag_set(
    monkeypatch,
) -> None:
    monkeypatch.setenv("CHATTICUS_DEVELOPMENT_GRANT_LIVE", "1")
    assert _EXERCISE._grant_http_required("development")
    assert not _EXERCISE._grant_http_required("staging")


def test_streamed_body_matches_completed_requires_joined_tokens() -> None:
    events = [
        {"kind": "turn.token", "seq": 2, "token": "You said: "},
        {"kind": "turn.token", "seq": 3, "token": "hello"},
        {"kind": "turn.completed", "seq": 4, "body": "You said: hello"},
    ]
    assert _EXERCISE._streamed_body_matches_completed(events)


def test_streamed_body_matches_completed_rejects_stale_greeting() -> None:
    events = [
        {"kind": "turn.token", "seq": 2, "token": "You said: "},
        {"kind": "turn.token", "seq": 3, "token": "hello"},
        {"kind": "turn.completed", "seq": 4, "body": "Hi! How can I help?"},
    ]
    assert not _EXERCISE._streamed_body_matches_completed(events)


def test_same_origin_api_client_put_forwards_path() -> None:
    client = _EXERCISE.SameOriginApiClient("https://example.test/api")
    captured: dict[str, str] = {}

    def fake_put(path: str, **kwargs: object) -> httpx.Response:
        captured["path"] = path
        return httpx.Response(
            200,
            request=httpx.Request("PUT", f"https://example.test{path}"),
        )

    client._client.put = fake_put  # type: ignore[method-assign]
    response = client.put("/turns/turn-1/grant", json={"tools": ["read_workspace"]})
    assert response.status_code == 200
    assert captured["path"] == "/api/turns/turn-1/grant"
