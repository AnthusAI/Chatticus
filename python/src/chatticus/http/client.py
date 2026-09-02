"""HTTP client for workers claiming turns, posting chunks, and waiting."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from chatticus.http.paths import org_path


@dataclass(frozen=True)
class GatedToolHttpError(Exception):
    """A gated tool HTTP route denied the request with a safe reason."""

    reason: str
    status_code: int

    def __str__(self) -> str:
        return self.reason


@dataclass
class HttpTurnClient:
    """POST /orgs/{tenant_id}/turns/{turn_id}/claim and /chunks for a worker."""

    client: Any
    tenant_id: str
    fence_token: int | None = None
    worker_token: str | None = None
    worker_id: str | None = None
    _worker_tokens: dict[str, str] = field(default_factory=dict)

    def _auth_headers(self, worker_id: str) -> dict[str, str]:
        if self.worker_token is not None and (
            self.worker_id is None or self.worker_id == worker_id
        ):
            return {"Authorization": f"Bearer {self.worker_token}"}
        token = self._worker_tokens.get(worker_id)
        if token is None:
            response = self.client.post(
                org_path(self.tenant_id, "/workers/register"),
                json={
                    "worker_id": worker_id,
                    "cost_class": "local",
                    "capabilities": ["cpu"],
                },
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    "worker register POST failed with status "
                    f"{response.status_code}: {response.text}"
                )
            token = response.json()["token"]
            self._worker_tokens[worker_id] = token
        return {"Authorization": f"Bearer {token}"}

    def claim(self, turn_id: str, worker_id: str) -> dict[str, Any]:
        """Take or observe ownership of a turn. acquired=false means skip the model."""
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/claim"),
            json={"worker_id": worker_id},
            headers=self._auth_headers(worker_id),
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
        self.worker_id = worker_id
        return payload

    def renew(
        self,
        turn_id: str,
        worker_id: str,
        *,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        """Extend the lease and queue visibility for the fenced owner."""
        if self.fence_token is None:
            raise RuntimeError("claim the turn before renewing the lease")
        payload: dict[str, Any] = {
            "worker_id": worker_id,
            "fence_token": self.fence_token,
        }
        if job_id is not None:
            payload["job_id"] = job_id
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/renew"),
            json=payload,
            headers=self._auth_headers(worker_id),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"renew POST failed with status {response.status_code}: "
                f"{response.text}"
            )
        return response.json()

    def post_chunk(self, turn_id: str, token: str, *, complete: bool = False) -> None:
        """Append one coalesced chunk, optionally completing the turn."""
        if self.fence_token is None:
            raise RuntimeError("claim the turn before posting chunks")
        worker_id = self.worker_id
        if worker_id is None:
            raise RuntimeError("claim the turn before posting chunks")
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/chunks"),
            json={
                "token": token,
                "complete": complete,
                "fence_token": self.fence_token,
            },
            headers=self._auth_headers(worker_id),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"chunk POST failed with status {response.status_code}: "
                f"{response.text}"
            )

    def post_waiting(self, turn_id: str, gate: str) -> None:
        """Record that the fenced owner is blocked on one readiness gate."""
        if self.fence_token is None:
            raise RuntimeError("claim the turn before posting waiting")
        worker_id = self.worker_id
        if worker_id is None:
            raise RuntimeError("claim the turn before posting waiting")
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/waiting"),
            json={
                "gate": gate,
                "fence_token": self.fence_token,
            },
            headers=self._auth_headers(worker_id),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"waiting POST failed with status {response.status_code}: "
                f"{response.text}"
            )

    def invoke_task_tool(
        self,
        bot_id: str,
        user_id: str,
        action: str,
        arguments: dict[str, str],
    ) -> dict[str, Any]:
        """Invoke the structured task tool for one bot at the first readiness gate."""
        worker_id = self.worker_id or "task-tool-worker"
        response = self.client.post(
            org_path(self.tenant_id, f"/bots/{bot_id}/tasks/tool"),
            json={
                "user_id": user_id,
                "action": action,
                "arguments": arguments,
            },
            headers=self._auth_headers(worker_id),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"task tool POST failed with status {response.status_code}: "
                f"{response.text}"
            )
        return response.json()

    def put_grant(
        self,
        turn_id: str,
        *,
        tools: list[str],
        origins: list[str] | None = None,
        recipients: list[str] | None = None,
        file_scopes: list[str] | None = None,
        egress_classes: list[str] | None = None,
        ingest_classes: list[str] | None = None,
    ) -> dict[str, Any]:
        """Attach one closed task grant to a turn."""
        worker_id = self.worker_id or "grant-worker"
        response = self.client.put(
            org_path(self.tenant_id, f"/turns/{turn_id}/grant"),
            json={
                "tools": tools,
                "origins": origins or [],
                "recipients": recipients or [],
                "file_scopes": file_scopes or [],
                "egress_classes": egress_classes or [],
                "ingest_classes": ingest_classes or [],
            },
            headers=self._auth_headers(worker_id),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"grant PUT failed with status {response.status_code}: "
                f"{response.text}"
            )
        return response.json()

    def read_workspace_gated(
        self,
        turn_id: str,
        user_id: str,
        path: str,
    ) -> dict[str, Any]:
        """Read one workspace path after the task grant allows it."""
        worker_id = self.worker_id or "workspace-worker"
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/workspace/read"),
            json={"user_id": user_id, "path": path},
            headers=self._auth_headers(worker_id),
        )
        if response.status_code == 403:
            raise GatedToolHttpError(
                _safe_http_detail(response),
                response.status_code,
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"workspace read POST failed with status {response.status_code}: "
                f"{response.text}"
            )
        return response.json()

    def authorize_browse(self, turn_id: str, url: str) -> dict[str, Any]:
        """Authorize one browse origin after the task grant allows it."""
        worker_id = self.worker_id or "browse-worker"
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/browse/authorize"),
            json={"url": url},
            headers=self._auth_headers(worker_id),
        )
        if response.status_code == 403:
            raise GatedToolHttpError(
                _safe_http_detail(response),
                response.status_code,
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"browse authorize POST failed with status {response.status_code}: "
                f"{response.text}"
            )
        return response.json()

    def deny_model_tool(
        self,
        turn_id: str,
        tool_name: str,
        arguments: dict[str, str],
    ) -> None:
        """Record one denied model tool through the control plane sink."""
        worker_id = self.worker_id or "deny-tool-worker"
        response = self.client.post(
            org_path(self.tenant_id, f"/turns/{turn_id}/tool/denied"),
            json={"tool_name": tool_name, "arguments": arguments},
            headers=self._auth_headers(worker_id),
        )
        if response.status_code == 403:
            raise GatedToolHttpError(
                _safe_http_detail(response),
                response.status_code,
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"tool denied POST failed with status {response.status_code}: "
                f"{response.text}"
            )


def _safe_http_detail(response: Any) -> str:
    """Return a FastAPI error detail string without raising."""
    try:
        body = response.json()
    except json.JSONDecodeError:
        return response.text or "denied"
    detail = body.get("detail")
    if detail is not None:
        return str(detail)
    return response.text or "denied"
