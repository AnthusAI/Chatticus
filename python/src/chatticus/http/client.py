"""HTTP client for workers posting turn chunks through the front door."""

from __future__ import annotations

from typing import Any


class HttpTurnClient:
    """POST /turns/{turn_id}/claim and /chunks for a tenant-scoped worker."""

    def __init__(
        self, client: Any, tenant_id: str, fence_token: int | None = None
    ) -> None:
        self.client = client
        self.tenant_id = tenant_id
        self.fence_token = fence_token

    def claim(self, turn_id: str, worker_id: str) -> dict[str, Any]:
        """Take or observe ownership of a turn. acquired=false means skip the model."""
        response = self.client.post(
            f"/turns/{turn_id}/claim",
            json={"worker_id": worker_id},
            headers={"X-Tenant-Id": self.tenant_id},
        )
        if response.status_code == 409:
            return {"acquired": False}
        if response.status_code >= 400:
            raise RuntimeError(
                f"claim POST failed with status {response.status_code}: "
                f"{response.text}"
            )
        payload = response.json()
        self.fence_token = int(payload["fence_token"])
        return payload

    def post_chunk(self, turn_id: str, token: str, *, complete: bool = False) -> None:
        """Append one coalesced chunk, optionally completing the turn."""
        if self.fence_token is None:
            raise RuntimeError("claim the turn before posting chunks")
        response = self.client.post(
            f"/turns/{turn_id}/chunks",
            json={
                "token": token,
                "complete": complete,
                "fence_token": self.fence_token,
            },
            headers={"X-Tenant-Id": self.tenant_id},
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"chunk POST failed with status {response.status_code}: "
                f"{response.text}"
            )
