"""Behave steps for waitlist triage scoring."""

from __future__ import annotations

from dataclasses import replace

from behave import given, then, when

_CONFIRMATION_TOKEN = "valid-confirmation-token"


def _reset_triage_signup_context(context: object, email: str) -> None:
    context.signup_email = email
    context.visitor_email = email
    context.triage_fit_answers: dict[str, str] = {}
    context.triage_aws_readiness_answers: dict[str, str] = {}
    context.triage_price_answers: dict[str, str] = {}
    context.triage_signup_recorded = False
    context.confirmation_token = _CONFIRMATION_TOKEN


def _ensure_triage_signup_recorded(context: object) -> None:
    if context.triage_signup_recorded:
        return
    context.plane.record_waitlist_signup(
        email=context.signup_email,
        fit_answers=context.triage_fit_answers,
        aws_readiness_answers=context.triage_aws_readiness_answers,
        price_answers=context.triage_price_answers,
        setup_path_answers={},
        price_sensitivity_answers=None,
        complete=True,
        source="behave-test",
    )
    signup = context.plane._messaging_store.get_waitlist_signup(context.signup_email)
    assert signup is not None
    context.plane._messaging_store.put_waitlist_signup(
        replace(
            signup,
            confirmation_token=_CONFIRMATION_TOKEN,
            email_confirmed=False,
        )
    )
    context.triage_signup_recorded = True


def _triage_signup(context: object):
    signup = context.plane._messaging_store.get_waitlist_signup(context.signup_email)
    assert signup is not None
    return signup


@given('a complete waitlist signup for "{email}" with email not yet confirmed')
def given_complete_unconfirmed_waitlist_signup(context: object, email: str) -> None:
    _reset_triage_signup_context(context, email)


@given("they run production workloads on AWS")
def given_production_workloads_on_aws(context: object) -> None:
    context.triage_aws_readiness_answers["cloud_provider"] = "aws"
    context.triage_aws_readiness_answers["account_status"] = "production-workloads"


@given("their organization has 101 or more people")
def given_organization_101_plus(context: object) -> None:
    context.triage_fit_answers["organization_size"] = "101-plus"


@given("they answered yes with budget to professional services")
def given_yes_with_budget_professional_services(context: object) -> None:
    context.triage_price_answers["professional_services_interest"] = "yes-with-budget"


@given("they can approve AWS access themselves")
def given_cloud_authority_self(context: object) -> None:
    context.triage_aws_readiness_answers["cloud_authority"] = "me"


@given("their organization has 1 to 5 people")
def given_organization_1_to_5(context: object) -> None:
    context.triage_fit_answers["organization_size"] = "1-to-5"


@given("they answered not now to professional services")
def given_not_now_professional_services(context: object) -> None:
    context.triage_price_answers["professional_services_interest"] = "not-now"


@given("they are just exploring")
def given_just_exploring(context: object) -> None:
    context.triage_aws_readiness_answers["account_status"] = "exploring-no-production"


@when("the visitor confirms their email")
def when_visitor_confirms_email(context: object) -> None:
    _ensure_triage_signup_recorded(context)
    context.plane.confirm_waitlist_email(context.signup_email)
    signup = _triage_signup(context)
    context.stored_waitlist_score = signup.waitlist_score
    context.stored_scoring_weights_version = signup.scoring_weights_version


@then("the signup waitlist score is at least {minimum:d}")
def then_signup_waitlist_score_at_least(context: object, minimum: int) -> None:
    signup = _triage_signup(context)
    assert signup.waitlist_score is not None
    assert signup.waitlist_score >= minimum


@then("the signup is marked services-qualified")
def then_signup_is_services_qualified(context: object) -> None:
    signup = _triage_signup(context)
    assert signup.services_qualified is True


@then("the signup is not marked services-qualified")
def then_signup_is_not_services_qualified(context: object) -> None:
    signup = _triage_signup(context)
    assert signup.services_qualified is False


@then('the signup carries scoring weights version "{expected_version}"')
def then_signup_carries_scoring_weights_version(
    context: object,
    expected_version: str,
) -> None:
    signup = _triage_signup(context)
    assert signup.scoring_weights_version == expected_version


@then("the signup still carries the original waitlist score")
def then_signup_still_carries_original_waitlist_score(context: object) -> None:
    signup = _triage_signup(context)
    assert signup.waitlist_score == context.stored_waitlist_score
    assert signup.waitlist_score is not None


@then('the signup still carries scoring weights version "{expected_version}"')
def then_signup_still_carries_scoring_weights_version(
    context: object,
    expected_version: str,
) -> None:
    signup = _triage_signup(context)
    assert signup.scoring_weights_version == expected_version
    assert signup.scoring_weights_version == context.stored_scoring_weights_version


@then("the signup is still marked services-qualified")
def then_signup_still_services_qualified(context: object) -> None:
    signup = _triage_signup(context)
    assert signup.services_qualified is True
