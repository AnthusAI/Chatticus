"""Helpers for the customer ChatticusComputers CloudFormation template."""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

from botocore.exceptions import ClientError

CREATE_STACK_TEMPLATE_BYTE_LIMIT = 51_200

CREATE_STACK_CAPABILITIES = ("CAPABILITY_IAM", "CAPABILITY_NAMED_IAM")


def create_stack_capabilities() -> list[str]:
    """Return IAM capabilities required for customer ChatticusComputers."""
    return list(CREATE_STACK_CAPABILITIES)


def is_stack_missing_error(error: ClientError) -> bool:
    """Return whether *error* means the ChatticusComputers stack does not exist."""
    response = error.response or {}
    code = str(response.get("Error", {}).get("Code", ""))
    message = str(response.get("Error", {}).get("Message", ""))
    if code in {"ValidationError", "ResourceNotFoundException"}:
        return True
    return "does not exist" in message.lower()


def is_no_stack_updates_error(error: ClientError) -> bool:
    """Return whether CloudFormation rejected UpdateStack because nothing changed."""
    message = str(error.response.get("Error", {}).get("Message", "")).lower()
    return "no updates are to be performed" in message


def template_delivery_for_create_stack(
    template_body: str,
    *,
    template_url: str | None = None,
    byte_limit: int = CREATE_STACK_TEMPLATE_BYTE_LIMIT,
) -> dict[str, str]:
    """Choose TemplateBody or TemplateURL for one CreateStack call."""
    encoded = template_body.encode("utf-8")
    if len(encoded) <= byte_limit:
        return {"TemplateBody": template_body}
    if not template_url:
        msg = (
            f"Customer ChatticusComputers template is {len(encoded)} bytes; "
            f"limit is {byte_limit} and no template URL was configured."
        )
        raise ValueError(msg)
    return {"TemplateURL": template_url}


def load_customer_computers_template() -> dict[str, Any]:
    """Load the committed customer ChatticusComputers CloudFormation template."""
    package = resources.files("chatticus.assets")
    raw = (package / "customer-computers.template.json").read_text(encoding="utf-8")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("customer-computers.template.json must be a JSON object.")
    return parsed


def customer_computers_template_body() -> str:
    """Return the customer template as a JSON string for CreateStack."""
    return json.dumps(load_customer_computers_template(), separators=(",", ":"))


def customer_computers_create_stack_parameters(
    *,
    tenant_id: str,
) -> list[dict[str, str]]:
    """Build CloudFormation parameters for one customer ChatticusComputers stack."""
    return [
        {"ParameterKey": "TenantId", "ParameterValue": tenant_id},
    ]
