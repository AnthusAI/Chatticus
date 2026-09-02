"""Behave steps for the members administrator CLI."""

from __future__ import annotations

import io

from behave import then, when
from organization_steps import _org_by_name, _plane

from chatticus.members.__main__ import main as members_main


@when('the members CLI lists organizations with status "{status}"')
def when_members_cli_lists(context: object, status: str) -> None:
    buffer = io.StringIO()
    plane = _plane(context)
    with _capture_stdout(buffer):
        context.members_cli_exit = members_main(
            ["list", "--status", status],
            plane_factory=lambda: plane,
        )
    context.members_cli_output = buffer.getvalue()


@when('the members CLI enables organization "{name}" with confirmation')
def when_members_cli_enables(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    plane = _plane(context)
    buffer = io.StringIO()
    with _capture_stdout(buffer):
        context.members_cli_exit = members_main(
            ["enable", org.tenant_id, "--yes"],
            plane_factory=lambda: plane,
        )
    context.members_cli_output = buffer.getvalue()


@when('the members CLI suspends organization "{name}" with confirmation')
def when_members_cli_suspends(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    plane = _plane(context)
    buffer = io.StringIO()
    with _capture_stdout(buffer):
        context.members_cli_exit = members_main(
            ["suspend", org.tenant_id, "--yes"],
            plane_factory=lambda: plane,
        )
    context.members_cli_output = buffer.getvalue()


@when('the members CLI reinstates organization "{name}" with confirmation')
def when_members_cli_reinstates(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    plane = _plane(context)
    buffer = io.StringIO()
    with _capture_stdout(buffer):
        context.members_cli_exit = members_main(
            ["reinstate", org.tenant_id, "--yes"],
            plane_factory=lambda: plane,
        )
    context.members_cli_output = buffer.getvalue()


@then('the members CLI output includes organization "{name}"')
def then_members_cli_includes(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    assert org.tenant_id in context.members_cli_output
    assert org.name in context.members_cli_output
    assert context.members_cli_exit == 0


@then('the members CLI output includes tenant "{tenant_id}"')
def then_members_cli_includes_tenant(context: object, tenant_id: str) -> None:
    assert tenant_id in context.members_cli_output
    assert context.members_cli_exit == 0


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
