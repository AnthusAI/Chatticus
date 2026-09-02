"""Behave steps for first organization seed and cold bootstrap."""

from __future__ import annotations

import io
from datetime import UTC, datetime
from uuid import uuid4

from behave import given, then, when
from organization_steps import _plane

from chatticus.control_plane import ControlPlane
from chatticus.members.__main__ import main as members_main
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import Bot, MemberRole, OrganizationStatus


@given(
    'a messaging store with tenant "{tenant_id}" user "{user_id}" bot data '
    "and no organization records"
)
def given_messaging_without_org_records(
    context: object, tenant_id: str, user_id: str
) -> None:
    context.plane = ControlPlane(messaging_store=InMemoryMessagingStore())
    context.orgs_by_name = {}
    context.identities_by_email = {}
    context.current_identity = None
    context.last_invitation = None
    context.last_error = None
    context.now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)
    context.bots_by_name = {}
    store = context.plane._messaging_store
    bot = Bot(
        bot_id=str(uuid4()),
        tenant_id=tenant_id,
        name="Researcher",
    )
    store.put_bot(bot, reserve_name=True)
    context.bots_by_name["Researcher"] = bot
    context.seed_bot_id = bot.bot_id


@when('the members CLI creates organization "{name}" for owner "{email}"')
def when_members_cli_creates(context: object, name: str, email: str) -> None:
    plane = _plane(context)
    buffer = io.StringIO()
    with _capture_stdout(buffer):
        context.members_cli_exit = members_main(
            [
                "create",
                "--owner-email",
                email,
                "--name",
                name,
                "--yes",
            ],
            plane_factory=lambda: plane,
        )
    context.members_cli_output = buffer.getvalue()
    assert context.members_cli_exit == 0, context.members_cli_output
    pending = plane.list_organizations_by_status(OrganizationStatus.PENDING)
    matches = [org for org in pending if org.name == name]
    assert len(matches) == 1, f"Expected one pending org named {name!r}."
    context.orgs_by_name[name] = matches[0]
    identity = plane.sign_in(email, now=context.now)
    context.current_identity = identity
    context.identities_by_email[email] = identity


@when(
    'the members CLI seeds tenant "{tenant_id}" for owner "{email}" with confirmation'
)
@when(
    'the members CLI seeds tenant "{tenant_id}" for owner "{email}" '
    "with confirmation again"
)
@when(
    'the members CLI seeds tenant "{tenant_id}" for owner "{email}" '
    'named "{name}" with confirmation'
)
def when_members_cli_seeds_tenant(
    context: object,
    tenant_id: str,
    email: str,
    name: str | None = None,
) -> None:
    plane = _plane(context)
    argv = [
        "seed",
        "--tenant-id",
        tenant_id,
        "--owner-email",
        email,
        "--yes",
    ]
    if name is not None:
        argv.extend(["--name", name])
    buffer = io.StringIO()
    with _capture_stdout(buffer):
        context.members_cli_exit = members_main(
            argv,
            plane_factory=lambda: plane,
        )
    context.members_cli_output = buffer.getvalue()
    assert context.members_cli_exit == 0, context.members_cli_output
    organization = plane.get_organization(tenant_id)
    context.orgs_by_name[organization.name] = organization


@then('organization tenant "{tenant_id}" has status "{status}"')
def then_tenant_org_status(context: object, tenant_id: str, status: str) -> None:
    organization = _plane(context).get_organization(tenant_id)
    assert organization.status == OrganizationStatus(status)


@then('organization tenant "{tenant_id}" has display name "{name}"')
def then_tenant_org_display_name(context: object, tenant_id: str, name: str) -> None:
    organization = _plane(context).get_organization(tenant_id)
    assert organization.name == name


@then('the identity for "{email}" is keyed in lowercase')
def then_identity_keyed_lowercase(context: object, email: str) -> None:
    store = _plane(context)._messaging_store
    normalized = email.strip().lower()
    identity = store.get_identity_by_email(normalized)
    assert identity is not None
    assert identity.email == normalized


@then('"{email}" is an owner member of tenant "{tenant_id}"')
def then_owner_member_of_tenant(context: object, email: str, tenant_id: str) -> None:
    plane = _plane(context)
    identity = plane.sign_in(email, now=context.now)
    membership = plane.get_membership(tenant_id, identity.user_id)
    assert membership is not None
    assert membership.role == MemberRole.OWNER


@then('"{email}" is not a member of tenant "{tenant_id}"')
def then_not_member_of_tenant(context: object, email: str, tenant_id: str) -> None:
    plane = _plane(context)
    identity = plane.sign_in(email, now=context.now)
    assert plane.get_membership(tenant_id, identity.user_id) is None


@then('tenant "{tenant_id}" user "{user_id}" bot data still exists')
def then_bot_data_still_exists(context: object, tenant_id: str, user_id: str) -> None:
    del user_id
    bot = _plane(context).bot(tenant_id, context.seed_bot_id)
    assert bot.name == "Researcher"


@then('no computer exists for tenant "{tenant_id}"')
def then_no_computer_for_tenant(context: object, tenant_id: str) -> None:
    plane = _plane(context)
    computer = plane._messaging_store.get_computer(tenant_id)
    assert computer is None


class _capture_stdout:
    def __init__(self, buffer: io.StringIO) -> None:
        self.buffer = buffer

    def __enter__(self) -> io.StringIO:
        import sys

        self._stdout = sys.stdout
        sys.stdout = self.buffer
        return self.buffer

    def __exit__(self, *args: object) -> None:
        import sys

        sys.stdout = self._stdout
