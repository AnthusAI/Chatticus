"""Behave steps for the beta waitlist survey."""

from behave import given, then, when


@given("a visitor on the beta page")
def given_visitor_on_beta_page(context: object) -> None:
    context.visitor_email = "jane@example.com"
    context.visitor_answers = {
        "fit": {"q1": "a1"},
        "aws_readiness": {"q2": "a2"},
        "price": {"q3": "a3"},
    }


@when("they complete the survey and submit it")
def when_they_complete_survey(context: object) -> None:
    response = context.api_client.post(
        "/waitlist",
        json={
            "email": context.visitor_email,
            "fit_answers": context.visitor_answers["fit"],
            "aws_readiness_answers": context.visitor_answers["aws_readiness"],
            "price_answers": context.visitor_answers["price"],
            "complete": True,
        },
    )
    assert response.status_code == 201, response.text
    context.last_waitlist_response = response.json()


@then("a waitlist signup is recorded for their work email")
@then("a waitlist signup is recorded for that email")
def then_waitlist_signup_recorded(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    context.last_signup = signup


@then("it carries their fit, AWS readiness, and price answers")
def then_it_carries_answers(context: object) -> None:
    signup = context.last_signup
    assert signup.fit_answers == context.visitor_answers["fit"]
    assert signup.aws_readiness_answers == context.visitor_answers["aws_readiness"]
    assert signup.price_answers == context.visitor_answers["price"]
    assert signup.complete is True


@given("a visitor who has entered only their work email")
def given_visitor_entered_only_email(context: object) -> None:
    context.visitor_email = "abandon@example.com"


@when("they leave the page without submitting")
def when_they_leave_without_submitting(context: object) -> None:
    response = context.api_client.post(
        "/waitlist",
        json={
            "email": context.visitor_email,
            "complete": False,
        },
    )
    assert response.status_code == 201, response.text


@then("it is marked incomplete")
def then_marked_incomplete(context: object) -> None:
    signup = context.last_signup
    assert signup.complete is False
    assert signup.fit_answers == {}
    assert signup.aws_readiness_answers == {}
    assert signup.price_answers == {}


@given('a waitlist signup exists for "{email}"')
def given_waitlist_signup_exists(context: object, email: str) -> None:
    context.visitor_email = email
    context.visitor_answers = {
        "fit": {"first": "yes"},
        "aws_readiness": {},
        "price": {},
    }
    response = context.api_client.post(
        "/waitlist",
        json={
            "email": email,
            "fit_answers": context.visitor_answers["fit"],
            "complete": True,
        },
    )
    assert response.status_code == 201, response.text
    context.first_signup = context.plane._messaging_store.get_waitlist_signup(email)


@when('a survey is submitted again for "{email}"')
def when_survey_submitted_again(context: object, email: str) -> None:
    from datetime import timedelta

    context.plane.set_now(context.plane._now + timedelta(seconds=60))
    context.visitor_answers_2 = {
        "fit": {"second": "yes"},
        "aws_readiness": {"ready": "yes"},
        "price": {},
    }
    response = context.api_client.post(
        "/waitlist",
        json={
            "email": email,
            "fit_answers": context.visitor_answers_2["fit"],
            "aws_readiness_answers": context.visitor_answers_2["aws_readiness"],
            "complete": True,
        },
    )
    assert response.status_code == 201, response.text


@then('one waitlist signup exists for "{email}"')
def then_one_waitlist_signup_exists(context: object, email: str) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(email)
    assert signup is not None
    context.last_signup = signup
    if hasattr(context, "first_signup") and context.first_signup:
        first_created_at = context.first_signup.created_at
        assert (
            signup.created_at == first_created_at
        ), f"created_at was modified: {signup.created_at} != {first_created_at}"


@then("it carries the answers from the second submission")
def then_it_carries_answers_from_second(context: object) -> None:
    signup = context.last_signup
    assert signup.fit_answers == context.visitor_answers_2["fit"]
    assert signup.aws_readiness_answers == context.visitor_answers_2["aws_readiness"]


@given('an incomplete waitlist signup exists for "{email}"')
def given_incomplete_waitlist_exists(context: object, email: str) -> None:
    context.visitor_email = email
    response = context.api_client.post(
        "/waitlist",
        json={
            "email": email,
            "complete": False,
        },
    )
    assert response.status_code == 201, response.text
    context.first_signup = context.plane._messaging_store.get_waitlist_signup(email)


@when("that visitor returns and completes the survey")
def when_visitor_returns_and_completes(context: object) -> None:
    from datetime import timedelta

    context.plane.set_now(context.plane._now + timedelta(seconds=60))
    context.visitor_answers_2 = {
        "fit": {"q1": "a1"},
        "aws_readiness": {},
        "price": {},
    }
    response = context.api_client.post(
        "/waitlist",
        json={
            "email": context.visitor_email,
            "fit_answers": context.visitor_answers_2["fit"],
            "complete": True,
        },
    )
    assert response.status_code == 201, response.text


@then("it is no longer marked incomplete")
def then_no_longer_marked_incomplete(context: object) -> None:
    signup = context.last_signup
    assert signup.complete is True
