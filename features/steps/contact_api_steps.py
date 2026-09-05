"""Behave steps for the /contact API endpoint (backend lead recording).

Covers the same backend behavior the marketing repo's contact_forms.feature
used to assert end-to-end before the marketing site moved to its own repo
(chatticus-3926bc) -- the marketing UI scenarios there now stop at "a
conversion event is fired"; this is the split-off backend half.
"""

from __future__ import annotations

from behave import then, when

SERVICES_PAYLOAD = {
    "contact_type": "professional_services",
    "name": "Jane Services",
    "organization": "Acme Corp",
    "details": {"resources_to_integrate": "Salesforce and Jira"},
}

TRAINING_PAYLOAD = {
    "contact_type": "professional_training",
    "name": "Jane Training",
    "organization": "Acme Corp",
    "details": {
        "team_size": "12",
        "topics_of_interest": "Bot design and routine automation",
    },
}


@when('a professional services contact lead is submitted for "{email}"')
def when_professional_services_contact_lead_submitted(
    context: object, email: str
) -> None:
    payload = {"email": email, **SERVICES_PAYLOAD}
    response = context.api_client.post("/contact", json=payload)
    assert response.status_code == 201, response.text
    context.contact_payload = payload


@when('a professional training contact lead is submitted for "{email}"')
def when_professional_training_contact_lead_submitted(
    context: object, email: str
) -> None:
    payload = {"email": email, **TRAINING_PAYLOAD}
    response = context.api_client.post("/contact", json=payload)
    assert response.status_code == 201, response.text
    context.contact_payload = payload


@then("a contact lead is recorded with type professional_services")
def then_services_contact_lead_recorded(context: object) -> None:
    payload = context.contact_payload
    lead = context.plane._messaging_store.get_contact_lead(
        payload["email"], "professional_services"
    )
    assert lead is not None
    assert lead.contact_type == "professional_services"
    assert lead.name == payload["name"]
    assert lead.organization == payload["organization"]
    assert lead.details == payload["details"]


@then("a contact lead is recorded with type professional_training")
def then_training_contact_lead_recorded(context: object) -> None:
    payload = context.contact_payload
    lead = context.plane._messaging_store.get_contact_lead(
        payload["email"], "professional_training"
    )
    assert lead is not None
    assert lead.contact_type == "professional_training"
    assert lead.name == payload["name"]
    assert lead.organization == payload["organization"]
    assert lead.details == payload["details"]
