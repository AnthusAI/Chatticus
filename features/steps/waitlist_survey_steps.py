"""Behave steps for the beta waitlist survey."""

from behave import given, then, when

from chatticus.models import PriceSensitivityAnswers


def _sample_price_sensitivity_answers() -> PriceSensitivityAnswers:
    return PriceSensitivityAnswers(
        too_cheap="15",
        bargain="35",
        expensive="90",
        too_expensive="175",
    )


def _waitlist_payload(
    *,
    email: str,
    fit_answers: dict[str, str] | None = None,
    aws_readiness_answers: dict[str, str] | None = None,
    price_answers: dict[str, str] | None = None,
    setup_path_answers: dict[str, str] | None = None,
    price_sensitivity_answers: PriceSensitivityAnswers | None = None,
    complete: bool,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "email": email,
        "fit_answers": fit_answers or {},
        "aws_readiness_answers": aws_readiness_answers or {},
        "price_answers": price_answers or {},
        "setup_path_answers": setup_path_answers or {},
        "complete": complete,
    }
    if price_sensitivity_answers is not None:
        payload["price_sensitivity_answers"] = price_sensitivity_answers.to_dict()
    return payload


@given("a visitor on the beta page")
def given_visitor_on_beta_page(context: object) -> None:
    context.visitor_email = "jane@example.com"
    context.visitor_answers = {
        "fit": {"q1": "a1"},
        "aws_readiness": {"q2": "a2"},
        "price": {"q3": "a3"},
        "setup_path": {"q4": "a4"},
        "price_sensitivity": _sample_price_sensitivity_answers(),
    }


@when("they complete the survey and submit it")
@when("they complete the survey")
def when_they_complete_survey(context: object) -> None:
    response = context.api_client.post(
        "/waitlist",
        json=_waitlist_payload(
            email=context.visitor_email,
            fit_answers=context.visitor_answers["fit"],
            aws_readiness_answers=context.visitor_answers["aws_readiness"],
            price_answers=context.visitor_answers["price"],
            setup_path_answers=context.visitor_answers["setup_path"],
            price_sensitivity_answers=context.visitor_answers["price_sensitivity"],
            complete=True,
        ),
    )
    assert response.status_code == 201, response.text
    context.last_waitlist_response = response.json()


@when("they complete the survey including the price block")
def when_they_complete_survey_including_price_block(context: object) -> None:
    context.visitor_price_sensitivity = _sample_price_sensitivity_answers()
    response = context.api_client.post(
        "/waitlist",
        json=_waitlist_payload(
            email=context.visitor_email,
            fit_answers=context.visitor_answers["fit"],
            aws_readiness_answers=context.visitor_answers["aws_readiness"],
            price_sensitivity_answers=context.visitor_price_sensitivity,
            complete=True,
        ),
    )
    assert response.status_code == 201, response.text


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
    assert signup.setup_path_answers == context.visitor_answers["setup_path"]
    assert (
        signup.price_sensitivity_answers == context.visitor_answers["price_sensitivity"]
    )
    assert signup.complete is True


@then("the waitlist signup records whether they want self-setup or assisted setup")
def then_waitlist_records_setup_path(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.setup_path_answers == context.visitor_answers["setup_path"]
    assert len(signup.setup_path_answers) > 0


@then("the waitlist signup records a too-cheap price")
def then_records_too_cheap_price(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.price_sensitivity_answers is not None
    assert (
        signup.price_sensitivity_answers.too_cheap
        == context.visitor_price_sensitivity.too_cheap
    )


@then("it records a bargain price")
def then_records_bargain_price(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.price_sensitivity_answers is not None
    assert (
        signup.price_sensitivity_answers.bargain
        == context.visitor_price_sensitivity.bargain
    )


@then("it records an expensive price")
def then_records_expensive_price(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.price_sensitivity_answers is not None
    assert (
        signup.price_sensitivity_answers.expensive
        == context.visitor_price_sensitivity.expensive
    )


@then("it records a too-expensive price")
def then_records_too_expensive_price(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.price_sensitivity_answers is not None
    assert (
        signup.price_sensitivity_answers.too_expensive
        == context.visitor_price_sensitivity.too_expensive
    )


@given("the beta page survey")
def given_beta_page_survey(context: object) -> None:
    response = context.api_client.get("/waitlist/survey")
    assert response.status_code == 200, response.text
    context.beta_page_survey = response.json()


@then("the price questions name the total including AWS and model tokens")
def then_price_questions_name_total_monthly_cost(context: object) -> None:
    questions = context.beta_page_survey["price_sensitivity"]
    assert len(questions) == 4
    for question in questions:
        prompt = question["prompt"].lower()
        assert "total monthly cost" in prompt
        assert "aws" in prompt
        assert "model token" in prompt or "model tokens" in prompt


@given("a visitor who has entered only their work email")
def given_visitor_entered_only_email(context: object) -> None:
    context.visitor_email = "abandon@example.com"


@when("they leave the page without submitting")
def when_they_leave_without_submitting(context: object) -> None:
    response = context.api_client.post(
        "/waitlist",
        json=_waitlist_payload(email=context.visitor_email, complete=False),
    )
    assert response.status_code == 201, response.text


@then("it is marked incomplete")
def then_marked_incomplete(context: object) -> None:
    signup = context.last_signup
    assert signup.complete is False
    assert signup.fit_answers == {}
    assert signup.aws_readiness_answers == {}
    assert signup.price_answers == {}
    assert signup.setup_path_answers == {}
    assert signup.price_sensitivity_answers is None


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


@given("a waitlist signup that has not been confirmed")
def given_unconfirmed_waitlist_signup(context: object) -> None:
    context.visitor_email = "unconfirmed@example.com"
    context.plane.record_waitlist_signup(
        email=context.visitor_email,
        fit_answers={},
        aws_readiness_answers={},
        price_answers={},
        setup_path_answers={},
        price_sensitivity_answers=None,
        complete=True,
        source="behave-test",
    )


@when("an operator lists the waitlist queue")
def when_operator_lists_queue(context: object) -> None:
    context.waitlist_queue = context.plane.list_waitlist_queue()


@then("that signup is not in the queue")
def then_signup_not_in_queue(context: object) -> None:
    emails = [s.email for s in context.waitlist_queue]
    assert context.visitor_email not in emails


@when("the visitor follows the confirmation link")
def when_visitor_follows_confirmation_link(context: object) -> None:
    context.plane.confirm_waitlist_email(context.visitor_email)


@then("that signup is in the queue")
def then_signup_is_in_queue(context: object) -> None:
    queue = context.plane.list_waitlist_queue()
    emails = [s.email for s in queue]
    assert context.visitor_email in emails
