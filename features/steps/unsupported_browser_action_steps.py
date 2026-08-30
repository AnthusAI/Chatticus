"""Behave steps for unbound authenticated browser consequential actions."""

from __future__ import annotations

from behave import given, when


@given("no structured connector or takeover control can bind the exact operation")
def given_unbound(context: object) -> None:
    context.structured_connector = False
    context.takeover_control = False


@when("the model attempts to {action} through an authenticated browser")
def when_browser_action(context: object, action: str) -> None:
    context.last_overnight = context.plane.attempt_authenticated_browser_action(
        action.strip(),
        structured_connector=getattr(context, "structured_connector", False),
        takeover_control=getattr(context, "takeover_control", False),
    )
