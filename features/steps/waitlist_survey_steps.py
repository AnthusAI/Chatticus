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
    assert response.status_code == 200, response.text
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
    assert response.status_code == 200, response.text


@then("it is marked incomplete")
def then_marked_incomplete(context: object) -> None:
    signup = context.last_signup
    assert signup.complete is False
    assert signup.fit_answers == {}
    assert signup.aws_readiness_answers == {}
    assert signup.price_answers == {}
