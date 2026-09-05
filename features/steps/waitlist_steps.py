"""Behave steps for the public waitlist endpoint."""

from behave import given, then, when
from fastapi.testclient import TestClient

from chatticus.http.principal import is_no_principal_route
from chatticus.http.waitlist_source import FORWARDED_FOR_HEADER
from chatticus.waitlist_limits import WAITLIST_SUBMISSION_RATE_LIMIT

_WAITLIST_SURVEY_BODY = {
    "email": "test@example.com",
    "complete": True,
}


@given("the thin-turn front door")
def given_front_door(context: object) -> None:
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
        "/waitlist",
        json=_WAITLIST_SURVEY_BODY,
    )


@given("a source that has submitted the waitlist survey at the allowed limit")
def given_source_at_waitlist_limit(context: object) -> None:
    context.waitlist_source_ip = "203.0.113.50"
    for index in range(WAITLIST_SUBMISSION_RATE_LIMIT):
        response = context.api_client.post(
            "/waitlist",
            headers={FORWARDED_FOR_HEADER: context.waitlist_source_ip},
            json={
                "email": f"flood{index}@example.com",
                "complete": True,
            },
        )
        assert response.status_code == 201, response.text


@when("that source submits the survey again")
def when_source_submits_waitlist_again(context: object) -> None:
    context.waitlist_overflow_email = "flood-overflow@example.com"
    context.waitlist_response = context.api_client.post(
        "/waitlist",
        headers={FORWARDED_FOR_HEADER: context.waitlist_source_ip},
        json={
            "email": context.waitlist_overflow_email,
            "complete": True,
        },
    )


@when("they post a waitlist survey with UTM source google and campaign beta_launch")
def when_post_waitlist_survey_with_utm(context: object) -> None:
    context.waitlist_utm_email = "utm-persistence@example.com"
    context.waitlist_response = context.api_client.post(
        "/waitlist",
        json={
            "email": context.waitlist_utm_email,
            "complete": True,
            "utm_source": "google",
            "utm_campaign": "beta_launch",
        },
    )


@then("the waitlist signup records the UTM source and campaign")
def then_waitlist_signup_records_utm(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(
        context.waitlist_utm_email
    )
    assert signup is not None
    assert signup.utm_source == "google"
    assert signup.utm_campaign == "beta_launch"


@then("the response is {status_code:d}")
def then_response_is(context: object, status_code: int) -> None:
    assert context.waitlist_response.status_code == status_code, (
        f"Expected {status_code}, got {context.waitlist_response.status_code}. "
        f"Response body: {context.waitlist_response.text}"
    )


@then("no principal was resolved for the request")
def then_no_principal_resolved(context: object) -> None:
    pass


@then("no additional waitlist signup is recorded")
def then_no_additional_waitlist_signup(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(
        context.waitlist_overflow_email
    )
    assert signup is None
