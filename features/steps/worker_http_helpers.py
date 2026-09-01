"""Shared HTTP helpers for worker bearer credentials in behave steps."""

from __future__ import annotations

from chatticus.http.paths import org_path
from chatticus.models import CostClass, WorkerRegistration


def _registration_payload(table: object) -> tuple[str, dict[str, object]]:
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    capabilities = [
        item.strip() for item in values["capabilities"].split(",") if item.strip()
    ]
    payload: dict[str, object] = {
        "worker_id": values["worker_id"],
        "cost_class": values["cost_class"],
        "capabilities": capabilities,
    }
    if values.get("computer_id"):
        payload["computer_id"] = values["computer_id"]
    return values["tenant_id"], payload


def registration_from_table(table: object) -> WorkerRegistration:
    """Build a worker registration from a two-column Gherkin table."""
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    capabilities = frozenset(
        item.strip() for item in values["capabilities"].split(",") if item.strip()
    )
    return WorkerRegistration(
        worker_id=values["worker_id"],
        tenant_id=values["tenant_id"],
        cost_class=CostClass(values["cost_class"]),
        capabilities=capabilities,
        computer_id=values.get("computer_id") or None,
    )


def ensure_worker_tokens(context: object) -> dict[str, str]:
    """Return the scenario worker token map, creating it when needed."""
    tokens = getattr(context, "worker_tokens", None)
    if tokens is None:
        context.worker_tokens = {}
        return context.worker_tokens
    return tokens


def register_worker_http(context: object, table: object) -> str:
    """Register one worker through the front door and store its bearer token."""
    tenant_id, payload = _registration_payload(table)
    response = context.api_client.post(
        org_path(tenant_id, "/workers/register"),
        json=payload,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    token = body["token"]
    ensure_worker_tokens(context)[body["worker_id"]] = token
    context.last_worker_token = token
    context.last_worker_id = body["worker_id"]
    context.last_worker_tenant_id = tenant_id
    return token


def worker_auth_headers(context: object, worker_id: str) -> dict[str, str]:
    """Return Authorization headers for one registered worker."""
    token = ensure_worker_tokens(context).get(worker_id)
    if token is None:
        raise AssertionError(
            f"No bearer token is stored for worker {worker_id!r}. "
            "Register the worker over HTTP first."
        )
    return {"Authorization": f"Bearer {token}"}


def register_worker_for_http(
    context: object,
    tenant_id: str,
    worker_id: str,
    *,
    cost_class: str = "local",
    capabilities: list[str] | None = None,
) -> str:
    """Register one worker for messaging scenarios that claim over HTTP."""
    caps = capabilities or ["cpu"]
    response = context.api_client.post(
        org_path(tenant_id, "/workers/register"),
        json={
            "worker_id": worker_id,
            "cost_class": cost_class,
            "capabilities": caps,
        },
    )
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    ensure_worker_tokens(context)[worker_id] = token
    return token


def sync_worker_from_turn_client(context: object, turn_client: object) -> None:
    """Copy worker bearer tokens from an HttpTurnClient into behave context."""
    worker_id = getattr(turn_client, "worker_id", None)
    if worker_id is None:
        return
    context.last_claim_worker_id = worker_id
    tokens = ensure_worker_tokens(context)
    for registered_id, token in getattr(turn_client, "_worker_tokens", {}).items():
        tokens[registered_id] = token
