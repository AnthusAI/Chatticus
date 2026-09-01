"""Register workers and build bearer Authorization headers for worker routes."""

from __future__ import annotations

from typing import Any, Protocol

from chatticus.http.paths import org_path


class HttpPostClient(Protocol):
    """Minimal HTTP client surface used to register a worker."""

    def post(self, path: str, **kwargs: Any) -> Any: ...


def register_worker_bearer(
    client: HttpPostClient,
    tenant_id: str,
    worker_id: str,
    *,
    base_headers: dict[str, str] | None = None,
    cost_class: str = "local",
    capabilities: list[str] | None = None,
) -> dict[str, str]:
    """Register one worker and return request headers with its bearer credential."""
    caps = capabilities or ["cpu"]
    headers = dict(base_headers or {})
    response = client.post(
        org_path(tenant_id, "/workers/register"),
        json={
            "worker_id": worker_id,
            "cost_class": cost_class,
            "capabilities": caps,
        },
        headers=headers,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            "worker register failed with status "
            f"{response.status_code}: {response.text[:300]}"
        )
    token = response.json()["token"]
    return {**headers, "Authorization": f"Bearer {token}"}
