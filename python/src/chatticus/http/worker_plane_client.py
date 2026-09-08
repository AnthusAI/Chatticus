"""HTTP-backed control-plane subset for customer computer hosts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from chatticus.capability_policy import (
    BrowserContextKind,
    CapabilityPolicy,
    PolicyBrowserContext,
    TaskCapabilityGrant,
)
from chatticus.computer_capabilities import ComputerCapabilityReadiness
from chatticus.computer_start import HostStartClaim
from chatticus.escalation_handoff import EscalationRecord, PendingComputerToolCall
from chatticus.http.app import HOST_USER_HEADER, HOST_WORKER_PREFIX, INVOKE_HEADER
from chatticus.http.paths import org_path
from chatticus.models import (
    Computer,
    ComputerPolicy,
    Turn,
    TurnEvent,
    TurnEventKind,
    TurnStatus,
)
from chatticus.worker.computer_worker_plane import ComputerWorkerPlane


@dataclass
class HttpWorkerPlane:
    """Front Door client implementing the computer host worker plane subset."""

    client: Any
    tenant_id: str
    user_id: str
    invoke_key: str = ""
    worker_id: str = "computer-host"
    _worker_tokens: dict[str, str] = field(default_factory=dict)

    def _headers(self, *, worker_id: str | None = None) -> dict[str, str]:
        headers: dict[str, str] = {HOST_USER_HEADER: self.user_id}
        if self.invoke_key:
            headers[INVOKE_HEADER] = self.invoke_key
        resolved_worker_id = worker_id or self.worker_id
        token = self._worker_tokens.get(resolved_worker_id)
        if token is None:
            response = self.client.post(
                org_path(self.tenant_id, "/workers/register"),
                json={
                    "worker_id": resolved_worker_id,
                    "cost_class": "local",
                    "capabilities": ["cpu", "computer"],
                },
                headers={
                    key: value
                    for key, value in headers.items()
                    if key != "Authorization"
                },
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    "worker register POST failed with status "
                    f"{response.status_code}: {response.text}"
                )
            token = response.json()["token"]
            self._worker_tokens[resolved_worker_id] = token
        headers["Authorization"] = f"Bearer {token}"
        return headers

    def _request(
        self,
        method: str,
        suffix: str,
        *,
        worker_id: str | None = None,
        **kwargs: Any,
    ) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.update(self._headers(worker_id=worker_id))
        response = self.client.request(
            method,
            org_path(self.tenant_id, f"{HOST_WORKER_PREFIX}{suffix}"),
            headers=headers,
            **kwargs,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"{method} {suffix} failed with status "
                f"{response.status_code}: {response.text}"
            )
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    def set_computer_stopped(self, tenant_id: str, stopped: bool) -> None:
        self._request(
            "POST",
            "/computers/stopped",
            json={"stopped": stopped},
        )

    def record_computer_capability_ready(
        self,
        tenant_id: str,
        user_id: str,
        capability: str,
    ) -> None:
        self._request(
            "POST",
            f"/computers/capabilities/{capability}/ready",
            json={"user_id": user_id},
        )

    def computer_for_organization(self, tenant_id: str) -> Computer:
        payload = self._request("GET", "/computer")
        return _computer_from_payload(payload)

    def list_active_turns(self, tenant_id: str, user_id: str) -> list[Turn]:
        payload = self._request("GET", f"/users/{user_id}/turns")
        return [_turn_from_payload(turn) for turn in payload["turns"]]

    def turn(self, tenant_id: str, turn_id: str) -> Turn:
        payload = self._request("GET", f"/turns/{turn_id}")
        return _turn_from_payload(payload)

    def remove_pending_job(self, job_id: str) -> None:
        del job_id

    def expire_orphaned_computer_claims(self) -> None:
        self._request("POST", "/computers/claims/expire-orphaned")

    def ensure_computer_escalation(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> EscalationRecord | None:
        payload = self._request(
            "POST",
            f"/turns/{turn_id}/computer/escalation/ensure",
        )
        if payload is None:
            return None
        record_payload = payload.get("record")
        if record_payload is None:
            return None
        return _escalation_from_payload(record_payload)

    def unresolved_tool_action_ids(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> list[str]:
        payload = self._request(
            "GET",
            f"/turns/{turn_id}/computer/unresolved-actions",
        )
        return list(payload["action_ids"])

    def request_computer_host_start(
        self,
        tenant_id: str,
        turn_id: str,
        *,
        user_id: str,
    ) -> HostStartClaim:
        computer = self.computer_for_organization(tenant_id)
        return HostStartClaim(
            tenant_id=tenant_id,
            computer_id=computer.computer_id,
            host_start_count=computer.host_start_generation,
            user_id=user_id,
        )

    def mark_host_start_dispatched(
        self,
        tenant_id: str,
        host_start_generation: int,
    ) -> bool:
        del tenant_id, host_start_generation
        return True

    def release_host_start_dispatch(
        self,
        tenant_id: str,
        host_start_generation: int,
    ) -> None:
        del tenant_id, host_start_generation

    def computer_capability_readiness(
        self,
        tenant_id: str,
    ) -> ComputerCapabilityReadiness:
        payload = self._request("GET", "/computer/readiness")
        return ComputerCapabilityReadiness(
            model_ready=payload["model_ready"],
            workspace_ready=payload["workspace_ready"],
            browser_ready=payload["browser_ready"],
        )

    def record_attempt_claimed(self, tenant_id: str, turn_id: str) -> TurnEvent:
        payload = self._request("POST", f"/turns/{turn_id}/attempt-claimed")
        return TurnEvent(
            event_id=str(payload["event_id"]),
            tenant_id=tenant_id,
            turn_id=turn_id,
            channel_id=str(payload["channel_id"]),
            seq=int(payload["seq"]),
            kind=TurnEventKind(payload["kind"]),
            body=payload.get("body"),
            action_id=payload.get("action_id"),
            attempt_id=payload.get("attempt_id"),
        )

    def claim_computer_for_turn(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
    ) -> bool:
        payload = self._request(
            "POST",
            f"/turns/{turn_id}/computer/claim",
            worker_id=worker_id,
            json={"worker_id": worker_id},
        )
        return bool(payload["claimed"])

    def commit_computer_tool_result(
        self,
        tenant_id: str,
        turn_id: str,
        result_body: str,
    ) -> None:
        self._request(
            "POST",
            f"/turns/{turn_id}/computer/tool-result",
            json={"result_body": result_body},
        )

    def execute_pending_computer_action(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> None:
        self._request("POST", f"/turns/{turn_id}/computer/execute-pending")

    def complete_computer_continuation(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> None:
        self._request("POST", f"/turns/{turn_id}/computer/complete")

    def active_browser_context(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> PolicyBrowserContext | None:
        payload = self._request("GET", f"/turns/{turn_id}/browser-context")
        context_payload = payload.get("context")
        if context_payload is None:
            return None
        return PolicyBrowserContext(
            kind=BrowserContextKind.UNTRUSTED,
            page_url="",
            named_session=context_payload.get("profile_path") or None,
            storage_partition=context_payload["storage_partition"],
        )

    def capability_policy_for(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> CapabilityPolicy:
        del tenant_id
        payload = self._request("GET", f"/turns/{turn_id}/capability-policy")
        policy = CapabilityPolicy()
        grant_payload = payload.get("grant")
        if grant_payload is not None:
            policy.set_grant(
                TaskCapabilityGrant(
                    tools=frozenset(grant_payload.get("tools") or []),
                    origins=frozenset(grant_payload.get("origins") or []),
                    recipients=frozenset(),
                    file_scopes=frozenset(),
                    egress_classes=frozenset(),
                    ingest_classes=frozenset(),
                )
            )
        return policy

    def gated_browse_origin(
        self,
        tenant_id: str,
        turn_id: str,
        url: str,
    ) -> None:
        self._request(
            "POST",
            f"/turns/{turn_id}/browse/regate",
            json={"url": url},
        )

    def record_computer_hydrated(
        self,
        tenant_id: str,
        worker_id: str,
    ) -> None:
        del tenant_id
        self._request(
            "POST",
            "/computers/snapshot/hydrated",
            json={"worker_id": worker_id},
        )

    def publish_computer_snapshot(
        self,
        tenant_id: str,
        worker_id: str,
        checksum: str,
    ) -> None:
        del tenant_id
        self._request(
            "POST",
            "/computers/snapshot/publish",
            json={"worker_id": worker_id, "checksum": checksum},
        )


def _computer_from_payload(payload: dict[str, Any]) -> Computer:
    return Computer(
        computer_id=payload["computer_id"],
        tenant_id=payload["tenant_id"],
        stopped=payload["stopped"],
        policy=ComputerPolicy(payload.get("policy", "prefer_local")),
        host_start_generation=int(payload.get("host_start_generation", 0)),
        model_ready=payload.get("model_ready", False),
        workspace_ready=payload.get("workspace_ready", False),
        browser_ready=payload.get("browser_ready", False),
        snapshot_uri=payload.get("snapshot_uri"),
        snapshot_checksum=payload.get("snapshot_checksum"),
        snapshot_generation=int(payload.get("snapshot_generation", 0)),
        disk_dirty=payload.get("disk_dirty", False),
        hydrate_required=payload.get("hydrate_required", False),
        intended_host_worker_id=payload.get("intended_host_worker_id"),
    )


def _turn_from_payload(payload: dict[str, Any]) -> Turn:
    pending = payload.get("pending_computer_tool")
    turn = Turn(
        turn_id=payload["turn_id"],
        tenant_id=payload["tenant_id"],
        channel_id=payload["channel_id"],
        bot_id=payload["bot_id"],
        status=TurnStatus(payload["status"]),
        waiting_for=payload.get("waiting_for"),
        claimed_by_worker_id=payload.get("claimed_by_worker_id"),
    )
    if pending is not None:
        turn.pending_computer_action_id = pending.get("action_id")
        turn.pending_computer_tool_name = pending.get("tool_name")
    return turn


def _escalation_from_payload(payload: dict[str, Any]) -> EscalationRecord:
    pending = payload["pending_call"]
    return EscalationRecord(
        turn_id=payload["turn_id"],
        tenant_id=payload["tenant_id"],
        user_id=payload["user_id"],
        computer_id=payload["computer_id"],
        pending_call=PendingComputerToolCall(
            action_id=pending["action_id"],
            tool_name=pending["tool_name"],
            arguments=dict(pending.get("arguments") or {}),
        ),
        call_committed=bool(payload.get("call_committed")),
        continuation_enqueued=bool(payload.get("continuation_enqueued")),
        computerless_relinquished=bool(payload.get("computerless_relinquished")),
        computer_action_count=int(payload.get("computer_action_count", 0)),
        result_committed=bool(payload.get("result_committed")),
        continuation_job_id=payload.get("continuation_job_id"),
        result_body=payload.get("result_body"),
        executed_action_id=payload.get("executed_action_id"),
    )


def worker_plane_from_client(
    client: Any,
    tenant_id: str,
    user_id: str,
    *,
    invoke_key: str = "",
) -> ComputerWorkerPlane:
    """Build one HTTP worker plane for a summoned customer host."""
    return HttpWorkerPlane(
        client,
        tenant_id,
        user_id,
        invoke_key=invoke_key,
    )
