"""System-controlled sinks that evaluate requests through CapabilityPolicy.

Workers and the control plane call these adapters at execution boundaries.
Grant tables, binding controls, and denial recording live only in
``capability_policy``; this module maps sink operations to that kernel.
"""

from __future__ import annotations

from chatticus.approval_binding import (
    ApprovalBindingGate,
    ApprovedOperation,
    BoundExecutionResult,
    StructuredConsequentialOperation,
)
from chatticus.capability_policy import (
    CapabilityPolicy,
    EgressClass,
    PolicyBrowserContext,
    RequestedCapability,
)
from chatticus.models import (
    CONSEQUENTIAL_ACTION_TYPES,
    ApprovalDecision,
    ChatticusError,
)
from chatticus.overnight_gated import (
    CHANNEL_BROWSER,
    OvernightGatedResult,
    resolve_unattended_gated_action,
)

POLICY_KERNEL_TENANT = "policy-tenant"
POLICY_KERNEL_TURN = "policy-turn"


class CapabilitySinkDenied(ChatticusError):
    """A model-requested operation was blocked at a system sink."""


class CapabilitySinkApprovalRequired(ChatticusError):
    """A model-requested operation requires immutable human approval."""


def structured_action_request(
    action_type: str, arguments: dict[str, str]
) -> RequestedCapability:
    """Build one capability request from a structured consequential action."""
    recipient = arguments.get("recipient") or arguments.get("destination")
    egress_class = None
    if action_type == "send":
        egress_class = EgressClass.STRUCTURED_SEND.value
    elif action_type in {"publish", "purchase", "delete", "production_change"}:
        egress_class = EgressClass.FILE_TRANSFER.value
    return RequestedCapability(
        tool=action_type,
        recipient=recipient,
        origin=arguments.get("origin"),
        file_path=arguments.get("file_path"),
        egress_class=egress_class,
    )


def require_allow(policy: CapabilityPolicy, request: RequestedCapability) -> None:
    """Raise when the policy denies or requires approval for one request."""
    decision = policy.evaluate(request)
    if decision == ApprovalDecision.DENY:
        reason = policy.denials[-1].reason if policy.denials else "denied"
        raise CapabilitySinkDenied(reason)
    if decision == ApprovalDecision.REQUIRE_APPROVAL:
        raise CapabilitySinkApprovalRequired("immutable approval required")


def require_granted(policy: CapabilityPolicy, request: RequestedCapability) -> None:
    """Raise only when the task grant denies the request."""
    decision = policy.evaluate(request)
    if decision == ApprovalDecision.DENY:
        reason = policy.denials[-1].reason if policy.denials else "denied"
        raise CapabilitySinkDenied(reason)


def gated_read_workspace(policy: CapabilityPolicy, path: str) -> None:
    """Authorize a workspace read at the file sink."""
    require_allow(
        policy,
        RequestedCapability(
            tool="read_workspace",
            file_path=path,
            egress_class=EgressClass.APPROVED_ORIGIN_FETCH.value,
        ),
    )


def gated_write_workspace(policy: CapabilityPolicy, path: str) -> None:
    """Authorize a workspace write at the file sink."""
    require_allow(
        policy,
        RequestedCapability(
            tool="write_workspace",
            file_path=path,
            egress_class=EgressClass.FILE_TRANSFER.value,
        ),
    )


def gated_browse_origin(policy: CapabilityPolicy, url: str) -> None:
    """Authorize opening or fetching one origin."""
    require_allow(
        policy,
        RequestedCapability(
            tool="browse",
            origin=url,
            egress_class=EgressClass.APPROVED_ORIGIN_FETCH.value,
        ),
    )


def gated_structured_send(
    policy: CapabilityPolicy, recipient: str, payload: str
) -> None:
    """Authorize binding one structured send at the connector sink."""
    require_granted(
        policy,
        RequestedCapability(
            tool="send",
            recipient=recipient,
            egress_class=EgressClass.STRUCTURED_SEND.value,
        ),
    )
    policy.bind_connector("send", recipient, payload)


def open_untrusted_browser_context(
    policy: CapabilityPolicy, page_url: str
) -> PolicyBrowserContext:
    """Open research browsing in an isolated context."""
    gated_browse_origin(policy, page_url)
    return policy.open_untrusted(page_url)


def open_privileged_browser_context(
    policy: CapabilityPolicy, page_url: str, service: str
) -> PolicyBrowserContext:
    """Open a named privileged session in its own partition."""
    gated_browse_origin(policy, page_url)
    return policy.open_privileged(page_url, service)


def gated_browser_session(
    policy: CapabilityPolicy,
    context: PolicyBrowserContext,
    service: str,
    session: str | None,
) -> str | None:
    """Return a session secret only when the active context may use it."""
    if session is not None and not policy.context_may_use(context, service):
        raise CapabilitySinkDenied(f"context cannot use browser session {service!r}")
    if session is not None:
        return session
    credential = policy.credentials.get(service)
    if credential is None or credential.kind != "browser_session":
        return None
    if not policy.context_may_use(context, service):
        return None
    return credential.value


def attempt_authenticated_browser_action_at_sink(
    policy: CapabilityPolicy,
    action: str,
    *,
    structured_connector: bool = False,
    takeover_control: bool = False,
) -> OvernightGatedResult:
    """Evaluate binding controls for one authenticated browser action."""
    if structured_connector or takeover_control:
        msg = "binding control is present; this path is for unbound actions"
        raise ValueError(msg)
    policy.required_binding_for_browser_action(action)
    result = policy.last_overnight
    if result is not None:
        return result
    action_type = action
    if action_type not in CONSEQUENTIAL_ACTION_TYPES:
        return OvernightGatedResult(
            executed=True,
            turn_status="completed",
            reason=None,
            completion_evidence=None,
        )
    return OvernightGatedResult(
        executed=False,
        turn_status="blocked",
        reason="user_controlled_completion_required",
        completion_evidence=None,
    )


def resolve_unattended_gated_action_at_sink(
    policy: CapabilityPolicy,
    *,
    action_type: str,
    arguments: dict[str, str],
    channel: str,
    rules: list,
    tenant_id: str,
    user_id: str | None = None,
    completion_evidence: str = "system-accepted",
) -> OvernightGatedResult:
    """Stop or pre-authorize a consequential action with no screen."""
    if policy.grant is None:
        if action_type in CONSEQUENTIAL_ACTION_TYPES:
            policy.evaluate(structured_action_request(action_type, arguments))
            return OvernightGatedResult(
                executed=False,
                turn_status="blocked",
                reason="no task grant",
                completion_evidence=None,
            )
    else:
        decision = policy.evaluate(structured_action_request(action_type, arguments))
        if decision == ApprovalDecision.DENY:
            reason = policy.denials[-1].reason if policy.denials else "denied"
            return OvernightGatedResult(
                executed=False,
                turn_status="blocked",
                reason=reason,
                completion_evidence=None,
            )
    if channel == CHANNEL_BROWSER and action_type in CONSEQUENTIAL_ACTION_TYPES:
        return attempt_authenticated_browser_action_at_sink(policy, action_type)
    return resolve_unattended_gated_action(
        action_type=action_type,
        arguments=arguments,
        channel=channel,
        rules=rules,
        tenant_id=tenant_id,
        user_id=user_id,
        completion_evidence=completion_evidence,
    )


def execute_approved_operation_at_sink(
    policy: CapabilityPolicy,
    gate: ApprovalBindingGate,
    approval: ApprovedOperation,
    attempted: StructuredConsequentialOperation,
    completion_evidence: str,
) -> BoundExecutionResult:
    """Execute one approved connector operation after grant and binding checks."""
    request = RequestedCapability(
        tool=attempted.action_type,
        recipient=attempted.destination,
        egress_class=EgressClass.STRUCTURED_SEND.value,
    )
    try:
        require_granted(policy, request)
    except CapabilitySinkDenied as exc:
        return BoundExecutionResult(
            executed=False,
            reason=str(exc),
            completion_evidence=None,
            requires_new_approval=True,
        )
    binding_result = gate.execute_approved_operation(
        approval,
        attempted,
        completion_evidence,
    )
    if binding_result.executed:
        policy.bind_connector(
            attempted.action_type,
            attempted.destination,
            attempted.payload,
        )
        policy.approve_bound_operation()
        policy.execute_bound_connector(completion_evidence)
    return binding_result


def binding_control_value(policy: CapabilityPolicy) -> str | None:
    """Return the last recorded binding control as a string, if any."""
    if policy.last_binding is None:
        return None
    return policy.last_binding.value
