"""Behave steps for organization monthly AWS spend ceiling."""

from __future__ import annotations

from decimal import Decimal

from behave import given, then, when
from browser_auth_helpers import wire_test_http_front_door
from cognito_test_support import make_cognito_test_keys, mint_id_token
from cross_account_provisioning_steps import (
    CUSTOMER_ACCOUNT_ID,
    CUSTOMER_ROLE_ARN,
    NOW,
    _ensure_org_store,
    _plane,
)

from chatticus.budget_rollup.models import BudgetRollupRow
from chatticus.budget_rollup.runner import CE_STATUS_OK, CE_STATUS_PENDING
from chatticus.computer_capabilities import WORKSPACE_CAPABILITY
from chatticus.computer_continuation_driver import prepare_workspace_tool_continuation
from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    CrossAccountRoleSnapshot,
    InMemoryCrossAccountRoleInspector,
)
from chatticus.host_starter import RecordingHostStarter
from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.models import (
    ActorKind,
    NotOrganizationOwnerError,
    OrganizationStatus,
    TurnEventKind,
)
from chatticus.organization_spend import (
    SPEND_CEILING_EXCEEDED_REASON,
    SPEND_CEILING_METER_UNAVAILABLE_REASON,
)
from chatticus.worker.computer import ComputerWorker
from chatticus.worker.computerless import (
    CapabilityAwareFakeTextCompletionClient,
    ComputerlessWorker,
)

DEFAULT_CEILING_USD = Decimal("250.00")
HIGHER_CEILING_USD = Decimal("500.00")
ABOVE_CEILING_MTD_USD = Decimal("300.00")
BUDGET_ENVIRONMENT = "development"
MEMBER_EMAIL = "member@example.com"
BOT_NAME = "Researcher"
CHANNEL_MESSAGE = "Budget pause check"


def _organization(context: object) -> object:
    organization = getattr(context, "spend_ceiling_org", None)
    if organization is None:
        raise AssertionError("No organization is set for spend ceiling scenarios.")
    return organization


def _reload_organization(context: object) -> object:
    organization = _organization(context)
    stored = _plane(context).get_organization(organization.tenant_id)
    assert stored is not None, organization.tenant_id
    context.spend_ceiling_org = stored
    return stored


def _tenant_id(context: object) -> str:
    return _organization(context).tenant_id


def _wire_http(context: object) -> None:
    keys = getattr(context, "cognito_test_keys", None)
    if keys is None:
        keys = make_cognito_test_keys()
        context.cognito_test_keys = keys
    wire_test_http_front_door(context, _plane(context), invoke_key="")


def _seed_mtd_above_ceiling(context: object) -> None:
    organization = _organization(context)
    rollup_date = context.now.date()
    store = _plane(context)._messaging_store
    _plane(context).budget_environment = BUDGET_ENVIRONMENT
    store.put_budget_rollup_row(
        BudgetRollupRow(
            tenant_id=organization.tenant_id,
            environment=BUDGET_ENVIRONMENT,
            rollup_date=rollup_date,
            aws_cost_usd=ABOVE_CEILING_MTD_USD,
            vendor_cost_usd=Decimal("0"),
            combined_report_usd=ABOVE_CEILING_MTD_USD,
            ce_status=CE_STATUS_OK,
            alert_events=(),
            updated_at=context.now,
        )
    )


def _seed_mtd_pending(context: object) -> None:
    organization = _organization(context)
    rollup_date = context.now.date()
    store = _plane(context)._messaging_store
    _plane(context).budget_environment = BUDGET_ENVIRONMENT
    store.put_budget_rollup_row(
        BudgetRollupRow(
            tenant_id=organization.tenant_id,
            environment=BUDGET_ENVIRONMENT,
            rollup_date=rollup_date,
            aws_cost_usd=None,
            vendor_cost_usd=Decimal("0"),
            combined_report_usd=None,
            ce_status=CE_STATUS_PENDING,
            alert_events=(),
            updated_at=context.now,
        )
    )


def _ensure_member_and_bot(context: object) -> None:
    organization = _organization(context)
    plane = _plane(context)
    member = getattr(context, "spend_ceiling_member", None)
    if member is None:
        owner = context.spend_ceiling_owner
        member = plane.sign_in(MEMBER_EMAIL, now=context.now)
        invitation = plane.invite_by_email(
            organization.tenant_id,
            owner.user_id,
            MEMBER_EMAIL,
            now=context.now,
        )
        plane.accept_invitation(invitation.invitation_id, member, now=context.now)
        context.spend_ceiling_member = member
    bots_by_name = getattr(context, "bots_by_name", None)
    if bots_by_name is None:
        bots_by_name = {}
        context.bots_by_name = bots_by_name
    if BOT_NAME not in bots_by_name:
        bots_by_name[BOT_NAME] = plane.create_bot(
            organization.tenant_id,
            BOT_NAME,
            creator_user_id=member.user_id,
        )
    context.policy_tenant_id = organization.tenant_id
    context.last_acting_user_id = member.user_id


def _provision_enabled_org_with_ceiling(context: object) -> None:
    _ensure_org_store(context)
    owner = _plane(context).sign_in("owner@example.com", now=context.now)
    organization = _plane(context).create_organization(
        owner,
        "Acme Labs",
        now=context.now,
    )
    context.spend_ceiling_owner = owner
    context.spend_ceiling_org = organization
    context.monthly_aws_spend_ceiling_usd = DEFAULT_CEILING_USD
    snapshot = CrossAccountRoleSnapshot(
        account_id=CUSTOMER_ACCOUNT_ID,
        role_arn=CUSTOMER_ROLE_ARN,
        trusted_external_id=organization.tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )
    role_inspector = InMemoryCrossAccountRoleInspector(
        {(CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN): snapshot}
    )
    result = _plane(context).submit_self_setup_cross_account_role(
        organization.tenant_id,
        actor_user_id=owner.user_id,
        account_id=CUSTOMER_ACCOUNT_ID,
        cross_account_role=CUSTOMER_ROLE_ARN,
        role_inspector=role_inspector,
        monthly_aws_spend_ceiling_usd=DEFAULT_CEILING_USD,
    )
    assert result.accepted is True, result.message
    context.spend_ceiling_org = result.organization
    _plane(context).budget_environment = BUDGET_ENVIRONMENT


@given("month-to-date spend rollup for today is pending")
def given_mtd_rollup_pending(context: object) -> None:
    _seed_mtd_pending(context)


@given("month-to-date spend has passed the ceiling")
def given_mtd_spend_passed_ceiling(context: object) -> None:
    _seed_mtd_above_ceiling(context)


@given("a queued computer continuation for workspace file read")
def given_queued_workspace_continuation(context: object) -> None:
    _ensure_member_and_bot(context)
    organization = _organization(context)
    member = context.spend_ceiling_member
    context.computer_continuation = prepare_workspace_tool_continuation(
        _plane(context),
        tool_name="read_workspace",
        arguments={"path": "/workspace/research/notes.txt"},
        tenant_id=organization.tenant_id,
        user_id=member.user_id,
    )
    _plane(context).set_computer_stopped(organization.tenant_id, True)
    context.last_turn_id = context.computer_continuation.turn_id
    context.policy_turn_id = context.computer_continuation.turn_id


@when("a computer-capable worker pulls the paused spend continuation job")
def when_computer_worker_pulls_paused_continuation(context: object) -> None:
    setup = context.computer_continuation
    _wire_http(context)
    context.host_starter = RecordingHostStarter()
    worker = ComputerWorker(
        _plane(context),
        HttpTurnClient(context.api_client, setup.tenant_id),
        host_starter=context.host_starter,
    )
    worker.run_job(setup.continuation_job)


@given("an organization being provisioned into a customer AWS account")
def given_org_being_provisioned(context: object) -> None:
    _ensure_org_store(context)
    owner = _plane(context).sign_in("owner@example.com", now=context.now)
    organization = _plane(context).create_organization(
        owner,
        "Acme Labs",
        now=context.now,
    )
    context.spend_ceiling_owner = owner
    context.spend_ceiling_org = organization
    context.monthly_aws_spend_ceiling_usd = DEFAULT_CEILING_USD
    snapshot = CrossAccountRoleSnapshot(
        account_id=CUSTOMER_ACCOUNT_ID,
        role_arn=CUSTOMER_ROLE_ARN,
        trusted_external_id=organization.tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )
    context.role_inspector = InMemoryCrossAccountRoleInspector(
        {(CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN): snapshot}
    )


@when("provisioning completes")
def when_provisioning_completes(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    result = _plane(context).submit_self_setup_cross_account_role(
        organization.tenant_id,
        actor_user_id=owner.user_id,
        account_id=CUSTOMER_ACCOUNT_ID,
        cross_account_role=CUSTOMER_ROLE_ARN,
        role_inspector=context.role_inspector,
        monthly_aws_spend_ceiling_usd=context.monthly_aws_spend_ceiling_usd,
    )
    assert result.accepted is True, result.message
    context.spend_ceiling_org = result.organization


@then("the organization carries a monthly AWS spend ceiling")
def then_org_carries_ceiling(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.monthly_aws_spend_ceiling_usd == DEFAULT_CEILING_USD
    assert organization.status == OrganizationStatus.ENABLED
    assert organization.aws_account_id == CUSTOMER_ACCOUNT_ID
    assert organization.aws_cross_account_role == CUSTOMER_ROLE_ARN


@given("an enabled organization with a monthly spend ceiling")
def given_enabled_org_with_ceiling(context: object) -> None:
    context.now = getattr(context, "now", NOW)
    _provision_enabled_org_with_ceiling(context)


@given("an enabled organization whose month-to-date spend has passed its ceiling")
def given_enabled_org_past_ceiling(context: object) -> None:
    context.now = getattr(context, "now", NOW)
    _provision_enabled_org_with_ceiling(context)
    _seed_mtd_above_ceiling(context)
    _ensure_member_and_bot(context)
    _wire_http(context)


@given("an organization whose work is paused at its spend ceiling")
def given_org_work_paused_at_ceiling(context: object) -> None:
    given_enabled_org_past_ceiling(context)


@given("the organization has a channel with a readable message")
def given_organization_channel_with_message(context: object) -> None:
    if not getattr(context, "spend_ceiling_member", None):
        _ensure_member_and_bot(context)
    _wire_http(context)
    member = context.spend_ceiling_member
    tenant_id = _tenant_id(context)
    bot = context.bots_by_name[BOT_NAME]
    channel = _plane(context).create_channel(
        tenant_id,
        member.user_id,
        [bot.bot_id],
    )
    _plane(context).post_channel_message(
        channel.channel_id,
        tenant_id,
        ActorKind.HUMAN,
        member.user_id,
        CHANNEL_MESSAGE,
    )
    context.spend_ceiling_channel_id = channel.channel_id


@when("a member asks a bot for work that needs the computer")
def when_member_asks_for_computer_work(context: object) -> None:
    _ensure_member_and_bot(context)
    member = context.spend_ceiling_member
    tenant_id = _tenant_id(context)
    bot = context.bots_by_name[BOT_NAME]
    plane = _plane(context)
    channel = plane.create_channel(
        tenant_id,
        member.user_id,
        [bot.bot_id],
    )
    _, turn = plane.post_channel_message(
        channel.channel_id,
        tenant_id,
        ActorKind.HUMAN,
        member.user_id,
        "read workspace file /workspace/research/notes.txt",
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    context.last_turn_id = turn.turn_id
    context.policy_turn_id = turn.turn_id
    grant = getattr(context, "capability_policy", None)
    if grant is not None and grant.grant is not None:
        plane.set_turn_capability_grant(
            tenant_id,
            turn.turn_id,
            grant.grant,
        )
    _wire_http(context)
    assert plane._messaging_store.get_turn(tenant_id, turn.turn_id) is not None
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(context.api_client, tenant_id),
        CapabilityAwareFakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)


@when("a member opens the workspace")
def when_member_opens_workspace(context: object) -> None:
    member = context.spend_ceiling_member
    token = mint_id_token(context.cognito_test_keys, email=MEMBER_EMAIL)
    context.me_response = context.api_client.get(
        "/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    context.channels_response = context.api_client.get(
        org_path(_tenant_id(context), f"/users/{member.user_id}/channels"),
        headers={"Authorization": f"Bearer {token}"},
    )


@when("its owner raises the ceiling above current spend")
def when_owner_raises_ceiling_above_spend(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    updated = _plane(context).set_monthly_aws_spend_ceiling(
        organization.tenant_id,
        owner.user_id,
        HIGHER_CEILING_USD,
    )
    context.spend_ceiling_org = updated


@when("its owner sets a higher ceiling")
def when_owner_sets_higher_ceiling(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    updated = _plane(context).set_monthly_aws_spend_ceiling(
        organization.tenant_id,
        owner.user_id,
        HIGHER_CEILING_USD,
    )
    context.spend_ceiling_org = updated


@then("the organization carries the new ceiling")
def then_org_carries_new_ceiling(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.monthly_aws_spend_ceiling_usd == HIGHER_CEILING_USD


@when("a member who is not an owner attempts to change it")
def when_member_attempts_change_ceiling(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    member = _plane(context).sign_in("member@example.com", now=context.now)
    invitation = _plane(context).invite_by_email(
        organization.tenant_id,
        owner.user_id,
        "member@example.com",
        now=context.now,
    )
    _plane(context).accept_invitation(
        invitation.invitation_id,
        member,
        now=context.now,
    )
    context.last_error = None
    try:
        _plane(context).set_monthly_aws_spend_ceiling(
            organization.tenant_id,
            member.user_id,
            HIGHER_CEILING_USD,
        )
    except NotOrganizationOwnerError as error:
        context.last_error = error


@then("the change is refused")
def then_change_refused(context: object) -> None:
    assert isinstance(context.last_error, NotOrganizationOwnerError), context.last_error


@then("the ceiling is unchanged")
def then_ceiling_unchanged(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.monthly_aws_spend_ceiling_usd == DEFAULT_CEILING_USD


@then("the request is refused with a spend meter unavailable reason")
def then_request_refused_with_meter_unavailable_reason(context: object) -> None:
    tenant_id = _tenant_id(context)
    events = _plane(context).list_turn_events(tenant_id, context.last_turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("denied:")
    ]
    assert results
    denied = results[-1].body.removeprefix("denied:").strip()
    assert denied == SPEND_CEILING_METER_UNAVAILABLE_REASON


@then("they see computer work paused for meter unavailability")
def then_meter_unavailable_pause_visible(context: object) -> None:
    assert context.me_response.status_code == 200
    me_payload = context.me_response.json()
    organizations = me_payload["organizations"]
    assert len(organizations) == 1
    organization = organizations[0]
    assert organization["computer_work_paused"] is True
    assert (
        organization["computer_work_paused_reason"]
        == SPEND_CEILING_METER_UNAVAILABLE_REASON
    )
    assert context.channels_response.status_code == 200


@then("the request is refused with a spend ceiling reason")
def then_request_refused_with_spend_ceiling_reason(context: object) -> None:
    tenant_id = _tenant_id(context)
    events = _plane(context).list_turn_events(tenant_id, context.last_turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("denied:")
    ]
    assert results
    denied = results[-1].body.removeprefix("denied:").strip()
    assert denied in {
        SPEND_CEILING_EXCEEDED_REASON,
        SPEND_CEILING_METER_UNAVAILABLE_REASON,
    }


@then("no computer is started")
def then_no_computer_is_started(context: object) -> None:
    tenant_id = _tenant_id(context)
    computer = _plane(context).computer_for_organization(tenant_id)
    assert computer.host_start_generation == 0
    jobs = [
        job
        for job in _plane(context)._jobs
        if job.turn_id == context.last_turn_id
        and "computer" in job.required_capabilities
    ]
    assert not jobs


@then("they read their channels and see why work is paused")
def then_channels_readable_and_pause_visible(context: object) -> None:
    assert context.me_response.status_code == 200
    me_payload = context.me_response.json()
    organizations = me_payload["organizations"]
    assert len(organizations) == 1
    organization = organizations[0]
    assert organization["computer_work_paused"] is True
    assert organization["computer_work_paused_reason"] in {
        SPEND_CEILING_EXCEEDED_REASON,
        SPEND_CEILING_METER_UNAVAILABLE_REASON,
    }
    assert context.channels_response.status_code == 200
    channels = context.channels_response.json()["channels"]
    channel_ids = {channel["channel_id"] for channel in channels}
    assert context.spend_ceiling_channel_id in channel_ids


@then("the organization status is still enabled")
def then_organization_status_still_enabled(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.status == OrganizationStatus.ENABLED
    me_payload = context.me_response.json()
    assert me_payload["organizations"][0]["status"] == "enabled"


@then("computer work is accepted again")
def then_computer_work_accepted_again(context: object) -> None:
    tenant_id = _tenant_id(context)
    turn = _plane(context).turn(tenant_id, context.last_turn_id)
    assert turn.waiting_for == WORKSPACE_CAPABILITY
    jobs = [
        job
        for job in _plane(context)._jobs
        if job.turn_id == context.last_turn_id
        and "computer" in job.required_capabilities
    ]
    assert jobs
