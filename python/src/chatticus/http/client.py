"""HTTP client for workers posting turn chunks through the front door."""

from __future__ import annotations

from typing import Any


class HttpTurnClient:
    """POST /turns/{turn_id}/chunks for a tenant-scoped worker."""

    def __init__(self, client: Any, tenant_id: str) -> None:
        self.client = client
        self.tenant_id = tenant_id

    def post_chunk(self, turn_id: str, token: str, *, complete: bool = False) -> None:
        """Append one coalesced chunk, optionally completing the turn."""
        response = self.client.post(
            f"/turns/{turn_id}/chunks",
            json={"token": token, "complete": complete},
            headers={"X-Tenant-Id": self.tenant_id},
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"chunk POST failed with status {response.status_code}: "
                f"{response.text}"
            )
