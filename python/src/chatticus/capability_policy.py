"""Executable capability, egress, and browser-context policy (kernel).

This module is the specified policy for epic 4ddbe1. It is not wired into
the live worker HTTP loop. Live sink enforcement is task 53d744.

Page content is data. The model may follow injected instructions; requested
operations are evaluated only against the human task grant, the active
browser context, and the binding control the action requires.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from urllib.parse import urlparse

from chatticus.models import CONSEQUENTIAL_ACTION_TYPES, ApprovalDecision
from chatticus.overnight_gated import (
    USER_CONTROLLED_COMPLETION_REQUIRED,
    OvernightGatedResult,
)


class EgressClass(StrEnum):
    """Outbound data classes a task may grant."""

    NONE = "none"
    APPROVED_ORIGIN_FETCH = "approved_origin_fetch"
    STRUCTURED_SEND = "structured_send"
    FILE_TRANSFER = "file_transfer"


class BindingControl(StrEnum):
    """How a consequential or identity-gated action may proceed."""

    STRUCTURED_CONNECTOR = "structured_connector"
    IMMUTABLE_APPROVAL = "immutable_approval"
    HUMAN_TAKEOVER = "human_takeover"
    UNBOUND_STOP = "unbound_stop"


class BrowserContextKind(StrEnum):
    """Browser contexts never share cookies, storage, or credentials."""

    UNTRUSTED = "untrusted"
    PRIVILEGED = "privileged"


V1_POLICY_EXCLUSIONS = frozenset(
    {
        "snapshot_cookie_integrity",
        "bot_to_bot_channel_injection",
        "approval_fatigue",
        "prompt_data_separation_as_boundary",
        "generic_browser_click_binding",
        "local_device_execution_isolation",
        "bot_as_security_boundary",
    }
)

CONSEQUENTIAL_BROWSER_ALIASES = {
    "send": "send",
    "publish": "publish",
    "purchase": "purchase",
    "delete": "delete",
    "change production": "production_change",
}


@dataclass(frozen=True)
class TaskCapabilityGrant:
    """Authority a human task may grant. Page content cannot add fields."""

    tools: frozenset[str]
    origins: frozenset[str]
    recipients: frozenset[str]
    file_scopes: frozenset[str]
    egress_classes: frozenset[str]


@dataclass(frozen=True)
class RequestedCapability:
    """One operation the model asks the worker to perform."""

    tool: str
    origin: str | None = None
    recipient: str | None = None
    file_path: str | None = None
    egress_class: str | None = None


@dataclass(frozen=True)
class CapabilityDenial:
    """One blocked request recorded for the user without exposing secrets."""

    reason: str
    request: RequestedCapability
    recorded_at: datetime


@dataclass(frozen=True)
class HouseholdCredential:
    """One secret that lives on the household computer."""

    kind: str
    name: str
    value: str


@dataclass
class PolicyBrowserContext:
    """One isolated browser context with its own storage partition."""

    kind: BrowserContextKind
    page_url: str
    named_session: str | None
    storage_partition: str
    cookies: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class BoundConnectorOperation:
    """A structured connector operation with exact destination and payload."""

    action_type: str
    destination: str
    payload: str
    approved: bool = False


def parse_grant_table(rows: dict[str, str]) -> TaskCapabilityGrant:
    """Build a grant from a two-column Gherkin table."""

    def _split(field_name: str) -> frozenset[str]:
        raw = rows.get(field_name, "")
        return frozenset(part.strip() for part in raw.split(",") if part.strip())

    return TaskCapabilityGrant(
        tools=_split("tools"),
        origins=_split("origins"),
        recipients=_split("recipients"),
        file_scopes=_split("file_scopes"),
        egress_classes=_split("egress_classes"),
    )


def _origin_from_url(url: str) -> str:
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = parsed.netloc or parsed.path.split("/", 1)[0]
    scheme = parsed.scheme or "https"
    return f"{scheme}://{host}"


def _file_in_scopes(path: str, scopes: frozenset[str]) -> bool:
    for scope in scopes:
        if path == scope or path.startswith(f"{scope.rstrip('/')}/"):
            return True
    return False


class CapabilityPolicy:
    """Evaluate grants, browser isolation, binding controls, and exclusions."""

    def __init__(self, *, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(tz=UTC))
        self.grant: TaskCapabilityGrant | None = None
        self.credentials: dict[str, HouseholdCredential] = {}
        self.denials: list[CapabilityDenial] = []
        self.egress_blocked: list[RequestedCapability] = []
        self.unblocked_egress: list[RequestedCapability] = []
        self.contexts: list[PolicyBrowserContext] = []
        self.last_decision: ApprovalDecision | None = None
        self.last_binding: BindingControl | None = None
        self.last_overnight: OvernightGatedResult | None = None
        self.bound_operation: BoundConnectorOperation | None = None
        self.recorded_exclusions: set[str] = set()
        self.claimed_enforced_exclusions: set[str] = set()
        self.channel_secret_accepted = False
        self.worker_completed_takeover_action = False
        self.sink_denial_is_control = False
        self.prompt_wording_is_boundary = False
        self.takeover_waiting = False

    def set_grant(self, grant: TaskCapabilityGrant) -> None:
        """Replace the active task grant."""
        self.grant = grant

    def add_credential(self, credential: HouseholdCredential) -> None:
        """Record a household secret. Untrusted browsing cannot use it."""
        self.credentials[credential.name] = credential

    def open_untrusted(self, page_url: str) -> PolicyBrowserContext:
        """Open research browsing without privileged credentials."""
        context = PolicyBrowserContext(
            kind=BrowserContextKind.UNTRUSTED,
            page_url=page_url,
            named_session=None,
            storage_partition="untrusted",
        )
        self.contexts.append(context)
        return context

    def open_privileged(self, page_url: str, service: str) -> PolicyBrowserContext:
        """Open a named privileged session in its own partition."""
        context = PolicyBrowserContext(
            kind=BrowserContextKind.PRIVILEGED,
            page_url=page_url,
            named_session=service,
            storage_partition=f"privileged:{service}",
        )
        self.contexts.append(context)
        return context

    def context_may_use(self, context: PolicyBrowserContext, name: str) -> bool:
        """Return whether this context may touch a named credential."""
        credential = self.credentials.get(name)
        if credential is None:
            return False
        if context.kind is BrowserContextKind.UNTRUSTED:
            return False
        if credential.kind != "browser_session":
            return False
        return context.named_session == name

    def workspace_secret_readable(
        self, context: PolicyBrowserContext, path: str
    ) -> bool:
        """Untrusted browsing cannot read ambient workspace secrets."""
        if context.kind is BrowserContextKind.UNTRUSTED:
            return False
        return any(
            cred.kind == "workspace_secret" and cred.value == path
            for cred in self.credentials.values()
        )

    def model_visible_secrets(self, context: PolicyBrowserContext) -> tuple[str, ...]:
        """Session secrets never appear in model-visible tool results."""
        _ = context
        return ()

    def write_cookie(
        self, context: PolicyBrowserContext, name: str, value: str
    ) -> None:
        """Write a cookie only into this context's partition."""
        context.cookies[name] = value

    def cookie_in_context(self, context: PolicyBrowserContext, name: str) -> str | None:
        """Read a cookie from this context's partition only."""
        return context.cookies.get(name)

    def evaluate(self, request: RequestedCapability) -> ApprovalDecision:
        """Deny or require approval using the task grant, never page text."""
        grant = self.grant
        if grant is None:
            return self._deny("no task grant", request)
        if request.tool not in grant.tools:
            return self._deny(f"tool {request.tool!r} is not granted", request)
        if request.origin:
            origin = _origin_from_url(request.origin)
            if origin not in grant.origins:
                return self._deny(f"origin {origin!r} is not granted", request)
        if request.recipient and request.recipient not in grant.recipients:
            return self._deny(
                f"recipient {request.recipient!r} is not granted", request
            )
        if request.file_path and not _file_in_scopes(
            request.file_path, grant.file_scopes
        ):
            return self._deny(
                f"file {request.file_path!r} is outside granted scopes", request
            )
        if request.egress_class and request.egress_class not in grant.egress_classes:
            return self._deny(
                f"egress class {request.egress_class!r} is not granted", request
            )
        if request.tool in CONSEQUENTIAL_ACTION_TYPES:
            self.last_decision = ApprovalDecision.REQUIRE_APPROVAL
            self.last_binding = BindingControl.IMMUTABLE_APPROVAL
            return ApprovalDecision.REQUIRE_APPROVAL
        self.last_decision = ApprovalDecision.ALLOW
        return ApprovalDecision.ALLOW

    def request_privileged_session(
        self, context: PolicyBrowserContext, service: str
    ) -> ApprovalDecision:
        """Refuse promoting an untrusted context to a privileged session."""
        request = RequestedCapability(tool="use_session", origin=context.page_url)
        if context.kind is BrowserContextKind.UNTRUSTED:
            return self._deny(
                "untrusted context cannot use privileged sessions", request
            )
        if context.named_session != service:
            return self._deny(
                "privileged context is bound to one named session", request
            )
        self.last_decision = ApprovalDecision.ALLOW
        return ApprovalDecision.ALLOW

    def required_binding_for_browser_action(
        self,
        action: str,
        *,
        structured_connector: bool = False,
        takeover_control: bool = False,
        approved: bool = False,
    ) -> BindingControl:
        """Return the control a consequential browser or connector action needs."""
        action_type = CONSEQUENTIAL_BROWSER_ALIASES.get(action, action)
        if takeover_control:
            self.last_binding = BindingControl.HUMAN_TAKEOVER
            return self.last_binding
        if not structured_connector and action_type in CONSEQUENTIAL_ACTION_TYPES:
            self.last_binding = BindingControl.UNBOUND_STOP
            self.last_overnight = OvernightGatedResult(
                executed=False,
                turn_status="blocked",
                reason=USER_CONTROLLED_COMPLETION_REQUIRED,
                completion_evidence=None,
            )
            self.record_exclusion("generic_browser_click_binding")
            return self.last_binding
        if structured_connector and not approved:
            self.last_binding = BindingControl.IMMUTABLE_APPROVAL
            self.last_overnight = OvernightGatedResult(
                executed=False,
                turn_status="blocked",
                reason="immutable_approval_required",
                completion_evidence=None,
            )
            return self.last_binding
        self.last_binding = BindingControl.STRUCTURED_CONNECTOR
        return self.last_binding

    def bind_connector(
        self, action_type: str, destination: str, payload: str
    ) -> BoundConnectorOperation:
        """Record a structured connector operation that can bind exact arguments."""
        operation = BoundConnectorOperation(
            action_type=action_type,
            destination=destination,
            payload=payload,
        )
        self.bound_operation = operation
        return operation

    def approve_bound_operation(self) -> None:
        """Bind human approval to the recorded connector operation."""
        if self.bound_operation is None:
            raise ValueError("no bound connector operation")
        self.bound_operation = BoundConnectorOperation(
            action_type=self.bound_operation.action_type,
            destination=self.bound_operation.destination,
            payload=self.bound_operation.payload,
            approved=True,
        )

    def execute_bound_connector(
        self, evidence: str = "smtp-250"
    ) -> OvernightGatedResult:
        """Execute only an approved structured connector operation."""
        operation = self.bound_operation
        if operation is None or not operation.approved:
            self.required_binding_for_browser_action(
                operation.action_type if operation else "send",
                structured_connector=True,
                approved=False,
            )
            result = self.last_overnight
            assert result is not None
            return result
        result = OvernightGatedResult(
            executed=True,
            turn_status="completed",
            reason=None,
            completion_evidence=evidence,
        )
        self.last_overnight = result
        self.last_binding = BindingControl.STRUCTURED_CONNECTOR
        return result

    def require_takeover(self, reason: str) -> BindingControl:
        """Hand the computer to the human. Secrets never arrive via the channel."""
        _ = reason
        self.last_binding = BindingControl.HUMAN_TAKEOVER
        self.channel_secret_accepted = False
        self.worker_completed_takeover_action = False
        self.takeover_waiting = True
        self.last_overnight = OvernightGatedResult(
            executed=False,
            turn_status="blocked",
            reason="waiting_for_human_takeover",
            completion_evidence=None,
        )
        return self.last_binding

    def record_exclusion(self, exclusion: str) -> None:
        """Name a v1 gap. Workers must not claim the missing control."""
        if exclusion not in V1_POLICY_EXCLUSIONS:
            raise ValueError(f"unknown v1 exclusion {exclusion!r}")
        self.recorded_exclusions.add(exclusion)

    def worker_claims_enforced(self, exclusion: str) -> bool:
        """Return whether any worker claimed a v1 exclusion as enforced."""
        return exclusion in self.claimed_enforced_exclusions

    def mark_injection_followed_by_model(self) -> None:
        """Record that prompt/data separation did not stop the model."""
        self.sink_denial_is_control = True
        self.prompt_wording_is_boundary = False
        self.record_exclusion("prompt_data_separation_as_boundary")

    def _deny(self, reason: str, request: RequestedCapability) -> ApprovalDecision:
        self.denials.append(
            CapabilityDenial(reason=reason, request=request, recorded_at=self._now())
        )
        if request.origin or request.recipient or request.egress_class:
            self.egress_blocked.append(request)
        self.last_decision = ApprovalDecision.DENY
        return ApprovalDecision.DENY
