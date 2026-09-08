"""Behave steps for granted agent terminal tools on the computer host."""

from __future__ import annotations

from behave import given, then, when
from computer_host_workspace_executor_steps import (
    _ensure_host_disk,
    _executor_live_root,
)

from chatticus.capability_policy import TaskCapabilityGrant
from chatticus.computer_continuation_driver import prepare_terminal_tool_continuation
from chatticus.host_action_executor import HostActionExecutor
from chatticus.http.client import HttpTurnClient
from chatticus.models import ActorKind, TurnEventKind
from chatticus.worker.computer import ComputerWorker

_TERMINAL_GRANT = TaskCapabilityGrant(
    tools=frozenset({"run_terminal", "read_workspace"}),
    origins=frozenset(),
    recipients=frozenset(),
    file_scopes=frozenset({"/workspace"}),
    egress_classes=frozenset(),
    ingest_classes=frozenset(),
)

_CANNOT_RUN_SHELL = "I can't run shell commands directly in the household workspace."


@given("a bot with a terminal grant on the household computer")
def given_bot_with_terminal_grant(context: object) -> None:
    from chatticus.capability_policy import CapabilityPolicy

    policy = CapabilityPolicy()
    policy.set_grant(_TERMINAL_GRANT)
    context.capability_policy = policy


@when('a human asks the bot to run command "{command}" using cwd "{cwd}"')
def when_human_asks_run_command(context: object, command: str, cwd: str) -> None:
    _post_run_command_request(context, command, cwd)


def _post_run_command_request(context: object, command: str, cwd: str) -> None:
    from chatticus.models import ActorKind

    bot = context.bots_by_name["Researcher"]
    channel = context.plane.create_channel(bot.tenant_id, "ryan", [bot.bot_id])
    message = f"run command {command} using cwd {cwd}"
    _, turn = context.plane.post_channel_message(
        channel.channel_id,
        bot.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        body=message,
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    context.last_turn_id = turn.turn_id
    context.last_channel = channel
    context.worker_bot_id = bot.bot_id
    context.policy_turn_id = turn.turn_id
    explicit_grant = getattr(context, "capability_policy", None)
    if explicit_grant is not None and explicit_grant.grant is not None:
        context.plane.set_turn_capability_grant(
            bot.tenant_id, turn.turn_id, explicit_grant.grant
        )


@given(
    "a fenced run_terminal handoff with a queued continuation job for "
    'command "{command}" using cwd "{cwd}"'
)
def given_run_terminal_handoff(context: object, command: str, cwd: str) -> None:
    context.computer_continuation = _prepare_run_terminal_handoff(
        context,
        command=command,
        cwd=cwd,
    )


@given(
    "a fenced run_terminal handoff with a tampered queued continuation job for "
    'command "{command}" using cwd "{cwd}"'
)
def given_tampered_run_terminal_handoff(
    context: object, command: str, cwd: str
) -> None:
    setup = _prepare_run_terminal_handoff(
        context,
        command="echo safe",
        cwd="/workspace/research",
    )
    record = context.plane.escalation_for(setup.tenant_id, setup.turn_id)
    record.pending_call.arguments["command"] = command
    record.pending_call.arguments["cwd"] = cwd
    for event in context.plane.list_turn_events(setup.tenant_id, setup.turn_id):
        snapshot = event.pending_computer_tool
        if event.kind != TurnEventKind.TOOL_CALL or snapshot is None:
            continue
        snapshot.arguments["command"] = command
        snapshot.arguments["cwd"] = cwd
        break
    context.computer_continuation = setup


@when(
    "a computer-capable pull worker with a terminal executor pulls that "
    "continuation job"
)
def when_worker_pulls_with_terminal_executor(context: object) -> None:
    setup = context.computer_continuation
    if not hasattr(context, "api_client"):
        from browser_auth_helpers import wire_test_http_front_door

        wire_test_http_front_door(context, context.plane, invoke_key="")
    _ensure_host_disk(
        context,
        getattr(context, "host_worker_id", None) or "garage-mac-1",
    )
    live_root = _executor_live_root(context)
    executor = HostActionExecutor(live_root=live_root)
    ComputerWorker(
        context.plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
        action_executor=executor,
    ).run_job(setup.continuation_job)


@when(
    "a computer-capable pull worker with a terminal executor completes the "
    "escalated turn"
)
def when_terminal_executor_completes_escalated_turn(context: object) -> None:
    turn_id = context.last_turn_id
    jobs = [
        job
        for job in context.plane._jobs
        if job.turn_id == turn_id and "computer" in job.required_capabilities
    ]
    assert jobs
    context.computer_continuation = type(
        "Setup",
        (),
        {
            "tenant_id": "anthus",
            "turn_id": turn_id,
            "continuation_job": jobs[-1],
        },
    )()
    when_worker_pulls_with_terminal_executor(context)


@then("the turn journal contains the command output from the host")
def then_journal_contains_host_command_output(context: object) -> None:
    events = context.plane.list_turn_events("anthus", context.last_turn_id)
    results = [
        event.body
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("run_terminal:exit=")
    ]
    assert results
    assert "host-marker" in results[-1]


@then("the bot does not only reply that it cannot run shell commands")
def then_bot_not_only_shell_denial(context: object) -> None:
    messages = context.plane.list_channel_messages(
        context.last_channel.channel_id, "anthus"
    )
    bot_bodies = [
        message.body
        for message in messages
        if message.author_kind == ActorKind.BOT and message.body
    ]
    assert bot_bodies
    last_body = bot_bodies[-1].strip()
    assert last_body != _CANNOT_RUN_SHELL
    assert _CANNOT_RUN_SHELL not in last_body or "host-marker" in last_body


@then(
    "the turn journal records a successful run_terminal tool result containing "
    '"{snippet}"'
)
def then_successful_run_terminal_contains(context: object, snippet: str) -> None:
    setup = getattr(context, "computer_continuation", None)
    turn_id = setup.turn_id if setup is not None else context.last_turn_id
    tenant_id = setup.tenant_id if setup is not None else "anthus"
    events = context.plane.list_turn_events(tenant_id, turn_id)
    results = [
        event.body
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("run_terminal:")
        and not event.body.startswith("denied:")
    ]
    assert results
    assert snippet in results[-1]


@then('the turn journal records a run_terminal tool result containing "{snippet}"')
def then_run_terminal_result_contains(context: object, snippet: str) -> None:
    setup = context.computer_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    tool_results = [
        event.body
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT and event.body
    ]
    assert any(snippet in body for body in tool_results)


@then("the turn journal records a denied run_terminal tool result")
def then_denied_run_terminal(context: object) -> None:
    turn_id = context.last_turn_id
    if hasattr(context, "computer_continuation"):
        turn_id = context.computer_continuation.turn_id
    events = context.plane.list_turn_events("anthus", turn_id)
    calls = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_CALL and event.body == "run_terminal"
    ]
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("denied:")
    ]
    assert calls
    assert results


def _prepare_run_terminal_handoff(
    context: object,
    *,
    command: str,
    cwd: str,
) -> object:
    grant = _TERMINAL_GRANT
    policy = getattr(context, "capability_policy", None)
    if policy is not None and policy.grant is not None:
        grant = policy.grant
    setup = prepare_terminal_tool_continuation(
        context.plane,
        command=command,
        cwd=cwd,
        grant=grant,
    )
    context.last_turn_id = setup.turn_id
    context.continuation_job = setup.continuation_job
    return setup
