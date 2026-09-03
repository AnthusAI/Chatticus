"""Behave steps for the public waitlist endpoint."""

from behave import given, then, when
from fastapi.testclient import TestClient

from chatticus.http.principal import is_no_principal_route


@given("the thin-turn front door")
def given_front_door(context: object) -> None:
    # the front door API client is provided by before_all in environment.py
    # and accessible via context.api_client
    pass


@then('"{path}" is a named no-principal route')
def then_is_named_no_principal_route(context: object, path: str) -> None:
    assert is_no_principal_route(path), f"{path} is not in NO_PRINCIPAL_ROUTES"


@given("a visitor with no Chatticus account")
def given_visitor_no_account(context: object) -> None:
    client: TestClient = context.api_client
    if "Authorization" in client.headers:
        del client.headers["Authorization"]


@when("they post a complete waitlist survey")
def when_post_waitlist_survey(context: object) -> None:
    context.waitlist_response = context.api_client.post(
        "/waitlist", json={"email": "test@example.com"}
    )


@then("the response is {status_code:d}")
def then_response_is(context: object, status_code: int) -> None:
    assert context.waitlist_response.status_code == status_code, (
        f"Expected {status_code}, got {context.waitlist_response.status_code}. "
        f"Response body: {context.waitlist_response.text}"
    )


@then("no principal was resolved for the request")
def then_no_principal_resolved(context: object) -> None:
    pass
