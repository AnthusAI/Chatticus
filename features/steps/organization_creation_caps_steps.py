"""Behave steps for organization creation caps and rate limits."""

from __future__ import annotations

import io

from behave import given, when
from create_organization_steps import _wire_front_door
from me_steps import _keys
from organization_steps import _plane

from chatticus.members.__main__ import main as members_main
from chatticus.org_creation_limits import ORGANIZATION_NAME_MAX_LENGTH
from chatticus.signup_mode import SignupMode


@given(
    "a Cognito-verified HTTP front door with open signup and "
    "organization creation rate limit {limit:d} per hour"
)
def given_open_signup_with_rate_limit(context: object, limit: int) -> None:
    _wire_front_door(context, signup_mode=SignupMode.OPEN)
    context.plane._org_creation_rate_limit = limit


@when(
    'POST /organizations is called with a valid id token for "{email}" '
    "and an overlong organization name"
)
def when_post_overlong_organization_name(context: object, email: str) -> None:
    from cognito_test_support import mint_id_token

    overlong_name = "A" * (ORGANIZATION_NAME_MAX_LENGTH + 1)
    token = mint_id_token(_keys(context), email=email)
    context.create_org_response = context.api_client.post(
        "/organizations",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": overlong_name},
    )
    context.create_org_name = overlong_name


@when('the members CLI creates organization "{name}" for "{email}" with confirmation')
def when_members_cli_creates_for_email(context: object, name: str, email: str) -> None:
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
    identity = context.identities_by_email.get(email)
    if identity is None:
        identity = plane.sign_in(email, now=context.now)
        context.identities_by_email[email] = identity
    if context.members_cli_exit == 0:
        orgs = plane.list_organizations_for_user(
            context.identities_by_email[email].user_id
        )
        for organization in orgs:
            if organization.name == name:
                context.orgs_by_name[name] = organization
                break


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
