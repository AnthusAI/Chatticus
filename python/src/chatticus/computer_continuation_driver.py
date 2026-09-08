"""Prepare a fenced handoff with a queued computer continuation job."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.capability_policy import TaskCapabilityGrant
from chatticus.computer_capabilities import BROWSER_CAPABILITY
from chatticus.control_plane import ControlPlane
from chatticus.escalation_driver import EscalationHandoffDriver
from chatticus.models import TurnJob


@dataclass
class ComputerContinuationSetup:
    """One turn ready for a computer-capable pull worker."""

    tenant_id: str
    user_id: str
    turn_id: str
    continuation_job: TurnJob
    pending_action_id: str


def prepare_computer_continuation(
    plane: ControlPlane,
    *,
    tenant_id: str = "anthus",
    user_id: str = "ryan",
) -> ComputerContinuationSetup:
    """Commit tool.call, enqueue continuation, and relinquish the computerless fence."""
    from http_test_support import DEFAULT_OWNER_EMAIL, _seed_org_for_user

    from chatticus.models import MemberRole, Membership, OrganizationNotFoundError

    try:
        plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        _seed_org_for_user(
            plane,
            tenant_id,
            user_id,
            owner_email=DEFAULT_OWNER_EMAIL,
        )
    else:
        if plane.get_membership(tenant_id, user_id) is None:
            plane._messaging_store.put_membership(
                Membership(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role=MemberRole.OWNER,
                    joined_at=plane.now(),
                )
            )
    driver = EscalationHandoffDriver(plane)
    driver.tenant_id = tenant_id
    driver.user_id = user_id
    driver.given_ready_to_request_computer_tool()
    assert driver.turn_id is not None
    record = plane.escalation_for(tenant_id, driver.turn_id)
    plane.record_model_request(tenant_id, driver.turn_id, "I will open household mail.")
    plane.commit_pending_computer_tool(tenant_id, driver.turn_id)
    plane.enqueue_computer_continuation(tenant_id, driver.turn_id)
    plane.relinquish_computerless_ownership(tenant_id, driver.turn_id)
    plane.set_computer_stopped(tenant_id, False)
    plane.record_computer_capability_ready(tenant_id, user_id, BROWSER_CAPABILITY)
    record = plane.escalation_for(tenant_id, driver.turn_id)
    assert record.continuation_job_id is not None
    job = next(job for job in plane._jobs if job.job_id == record.continuation_job_id)
    assert "computer" in job.required_capabilities
    return ComputerContinuationSetup(
        tenant_id=tenant_id,
        user_id=user_id,
        turn_id=driver.turn_id,
        continuation_job=job,
        pending_action_id=record.pending_call.action_id,
    )


def prepare_workspace_tool_continuation(
    plane: ControlPlane,
    *,
    tool_name: str,
    arguments: dict[str, str],
    tenant_id: str = "anthus",
    user_id: str = "ryan",
) -> ComputerContinuationSetup:
    """Commit one workspace tool call and enqueue computer continuation."""
    from http_test_support import DEFAULT_OWNER_EMAIL, _seed_org_for_user

    from chatticus.capability_policy import parse_grant_table
    from chatticus.models import (
        ActorKind,
        MemberRole,
        Membership,
        OrganizationNotFoundError,
    )

    try:
        plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        _seed_org_for_user(
            plane,
            tenant_id,
            user_id,
            owner_email=DEFAULT_OWNER_EMAIL,
        )
    else:
        if plane.get_membership(tenant_id, user_id) is None:
            plane._messaging_store.put_membership(
                Membership(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role=MemberRole.OWNER,
                    joined_at=plane.now(),
                )
            )
    try:
        bot = plane.bot_by_name(tenant_id, "Researcher")
    except KeyError:
        bot = plane.create_bot(tenant_id, "Researcher", creator_user_id=user_id)
    channel = plane.create_channel(tenant_id, user_id, [bot.bot_id])
    _, started = plane.post_channel_message(
        channel.channel_id,
        tenant_id,
        ActorKind.HUMAN,
        user_id,
        f"run {tool_name}",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    turn_id = started.turn_id
    grant = parse_grant_table(
        {
            "tools": "browse, read_workspace, write_workspace",
            "origins": "https://docs.example.com",
            "recipients": "",
            "file_scopes": "/workspace/research",
            "egress_classes": "approved_origin_fetch, file_transfer",
        }
    )
    plane.set_turn_capability_grant(tenant_id, turn_id, grant)
    claimed = plane.claim_turn_attempt(tenant_id, turn_id, "computerless-worker")
    assert claimed is not None and claimed.acquired
    plane.prepare_computer_tool(
        tenant_id,
        turn_id,
        tool_name=tool_name,
        arguments=dict(arguments),
    )
    plane.commit_pending_computer_tool(tenant_id, turn_id)
    plane.enqueue_computer_continuation(tenant_id, turn_id)
    plane.relinquish_computerless_ownership(tenant_id, turn_id)
    plane.set_computer_stopped(tenant_id, False)
    record = plane.escalation_for(tenant_id, turn_id)
    assert record.continuation_job_id is not None
    job = next(job for job in plane._jobs if job.job_id == record.continuation_job_id)
    return ComputerContinuationSetup(
        tenant_id=tenant_id,
        user_id=user_id,
        turn_id=turn_id,
        continuation_job=job,
        pending_action_id=record.pending_call.action_id,
    )


def prepare_terminal_tool_continuation(
    plane: ControlPlane,
    *,
    command: str,
    cwd: str = "/workspace",
    grant: TaskCapabilityGrant | None = None,
    tenant_id: str = "anthus",
    user_id: str = "ryan",
) -> ComputerContinuationSetup:
    """Commit one run_terminal tool call and enqueue computer continuation."""
    from http_test_support import DEFAULT_OWNER_EMAIL, _seed_org_for_user

    from chatticus.capability_policy import parse_grant_table
    from chatticus.models import (
        ActorKind,
        MemberRole,
        Membership,
        OrganizationNotFoundError,
    )

    try:
        plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        _seed_org_for_user(
            plane,
            tenant_id,
            user_id,
            owner_email=DEFAULT_OWNER_EMAIL,
        )
    else:
        if plane.get_membership(tenant_id, user_id) is None:
            plane._messaging_store.put_membership(
                Membership(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role=MemberRole.OWNER,
                    joined_at=plane.now(),
                )
            )
    try:
        bot = plane.bot_by_name(tenant_id, "Researcher")
    except KeyError:
        bot = plane.create_bot(tenant_id, "Researcher", creator_user_id=user_id)
    channel = plane.create_channel(tenant_id, user_id, [bot.bot_id])
    _, started = plane.post_channel_message(
        channel.channel_id,
        tenant_id,
        ActorKind.HUMAN,
        user_id,
        "run terminal command",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    turn_id = started.turn_id
    resolved_grant = grant or parse_grant_table(
        {
            "tools": "run_terminal, read_workspace",
            "origins": "",
            "recipients": "",
            "file_scopes": "/workspace",
            "egress_classes": "",
        }
    )
    plane.set_turn_capability_grant(tenant_id, turn_id, resolved_grant)
    claimed = plane.claim_turn_attempt(tenant_id, turn_id, "computerless-worker")
    assert claimed is not None and claimed.acquired
    plane.prepare_computer_tool(
        tenant_id,
        turn_id,
        tool_name="run_terminal",
        arguments={"command": command, "cwd": cwd},
    )
    plane.commit_pending_computer_tool(tenant_id, turn_id)
    plane.enqueue_computer_continuation(tenant_id, turn_id)
    plane.relinquish_computerless_ownership(tenant_id, turn_id)
    plane.set_computer_stopped(tenant_id, False)
    record = plane.escalation_for(tenant_id, turn_id)
    assert record.continuation_job_id is not None
    job = next(job for job in plane._jobs if job.job_id == record.continuation_job_id)
    return ComputerContinuationSetup(
        tenant_id=tenant_id,
        user_id=user_id,
        turn_id=turn_id,
        continuation_job=job,
        pending_action_id=record.pending_call.action_id,
    )
