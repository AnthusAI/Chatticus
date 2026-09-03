"""Behave steps for public contact forms."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when
from marketing_positioning_steps import _run_harness

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = REPO_ROOT / "web"
CONTACT_HARNESS = WEB_DIR / "test-support" / "contact-form-harness.ts"
CONTACT_HARNESS_STATE = REPO_ROOT / ".contact-form-harness-state.json"

SERVICES_PAYLOAD = {
    "email": "services@example.com",
    "contact_type": "professional_services",
    "name": "Jane Services",
    "organization": "Acme Corp",
    "details": {"resources_to_integrate": "Salesforce and Jira"},
}

TRAINING_PAYLOAD = {
    "email": "training@example.com",
    "contact_type": "professional_training",
    "name": "Jane Training",
    "organization": "Acme Corp",
    "details": {
        "team_size": "12",
        "topics_of_interest": "Bot design and routine automation",
    },
}


def _tsx_binary() -> Path:
    candidates = (
        WEB_DIR / "node_modules" / ".bin" / "tsx",
        REPO_ROOT / "node_modules" / ".bin" / "tsx",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "tsx not found; run npm install at the repo root "
        f"(checked {candidates[0]} and {candidates[1]})"
    )


def _run_contact_harness(command: str, payload: dict | None = None) -> dict:
    tsx = _tsx_binary()
    args = [str(tsx), str(CONTACT_HARNESS), command]
    if payload is not None:
        args.append(json.dumps(payload))
    env = {
        **dict(__import__("os").environ),
        "CHATTICUS_CONTACT_FORM_HARNESS_STATE": str(CONTACT_HARNESS_STATE),
    }
    result = subprocess.run(
        args,
        cwd=WEB_DIR,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"contact form harness failed ({command}): "
            f"{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


@given("the Chatticus marketing site")
def given_chatticus_marketing_site(context: object) -> None:
    pass


@given("a visitor on the contact services page")
def given_visitor_on_contact_services_page(context: object) -> None:
    context.contact_form_harness = _run_contact_harness("reset-services")
    context.marketing_ui_harness = _run_harness("render-contact-services")
    context.contact_payload = SERVICES_PAYLOAD


@given("a visitor on the contact training page")
def given_visitor_on_contact_training_page(context: object) -> None:
    context.contact_form_harness = _run_contact_harness("reset-training")
    context.marketing_ui_harness = _run_harness("render-contact-training")
    context.contact_payload = TRAINING_PAYLOAD


@then(
    "it shows a form with name, email, organization, "
    "and a field for what resources to integrate"
)
def then_shows_services_contact_form_fields(context: object) -> None:
    html = (context.marketing_ui_harness.get("html") or "").lower()
    assert 'name="name"' in html, html
    assert 'name="email"' in html, html
    assert 'name="organization"' in html, html
    assert 'name="resources_to_integrate"' in html, html


@then(
    "it shows a form with name, email, organization, team size, and topics of interest"
)
def then_shows_training_contact_form_fields(context: object) -> None:
    html = (context.marketing_ui_harness.get("html") or "").lower()
    assert 'name="name"' in html, html
    assert 'name="email"' in html, html
    assert 'name="organization"' in html, html
    assert 'name="team_size"' in html, html
    assert 'name="topics_of_interest"' in html, html


@when("they submit the form")
def when_they_submit_contact_form(context: object) -> None:
    payload = context.contact_payload
    command = (
        "submit-services"
        if payload["contact_type"] == "professional_services"
        else "submit-training"
    )
    context.contact_form_harness = _run_contact_harness(command, payload)
    response = context.api_client.post("/contact", json=payload)
    assert response.status_code == 201, response.text
    context.contact_response = response.json()


@then("a contact lead is recorded with type professional_services")
def then_services_contact_lead_recorded(context: object) -> None:
    lead = context.plane._messaging_store.get_contact_lead(
        "services@example.com",
        "professional_services",
    )
    assert lead is not None
    assert lead.contact_type == "professional_services"
    assert lead.name == "Jane Services"
    assert lead.organization == "Acme Corp"
    assert lead.details == {"resources_to_integrate": "Salesforce and Jira"}


@then("a contact lead is recorded with type professional_training")
def then_training_contact_lead_recorded(context: object) -> None:
    lead = context.plane._messaging_store.get_contact_lead(
        "training@example.com",
        "professional_training",
    )
    assert lead is not None
    assert lead.contact_type == "professional_training"
    assert lead.name == "Jane Training"
    assert lead.organization == "Acme Corp"
    assert lead.details == {
        "team_size": "12",
        "topics_of_interest": "Bot design and routine automation",
    }


@then("a contact_services conversion event is fired")
def then_contact_services_conversion_event_fired(context: object) -> None:
    events = context.contact_form_harness.get("conversionEvents") or []
    assert "contact_services" in events, events


@then("a contact_training conversion event is fired")
def then_contact_training_conversion_event_fired(context: object) -> None:
    events = context.contact_form_harness.get("conversionEvents") or []
    assert "contact_training" in events, events


@then("it links to /contact/services")
def then_links_to_contact_services(context: object) -> None:
    html = context.marketing_ui_harness.get("html") or ""
    assert 'href="/contact/services"' in html, html


@then("it links to /contact/training")
def then_links_to_contact_training(context: object) -> None:
    html = context.marketing_ui_harness.get("html") or ""
    assert 'href="/contact/training"' in html, html
