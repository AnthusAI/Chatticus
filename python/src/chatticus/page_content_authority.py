"""Contain page-content-driven requests within a task's granted authority.

Page content is data, never instruction. A model may read untrusted pages,
but requested operations are evaluated only against the task grant and the
active browsing context, not against text encountered mid-task.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse

from chatticus.models import ApprovalDecision


@dataclass(frozen=True)
class TaskAuthorityGrant:
    """Authority a human task may grant for one turn."""

    approved_origins: frozenset[str]
    allow_workspace_upload: bool = False
    allow_messaging: bool = False
    allow_external_recipient: bool = False


@dataclass(frozen=True)
class RequestedOperation:
    """One operation the model asks the worker to perform."""

    action_type: str
    destination: str | None = None
    payload: str | None = None


@dataclass(frozen=True)
class AuthorityDenial:
    """One blocked request recorded for the user."""

    reason: str
    operation: RequestedOperation
    recorded_at: datetime


@dataclass(frozen=True)
class BrowsingContext:
    """An isolated browser session for one page or privileged surface."""

    page_origin: str | None
    privileged: bool
    available_session_services: frozenset[str]


@dataclass(frozen=True)
class EgressAttempt:
    """One outbound data transfer the worker evaluated."""

    destination: str
    payload: str
    blocked: bool


class PageContentAuthorityGate:
    """Evaluate model requests against task grants and browsing isolation."""

    def __init__(
        self,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._now = now or (lambda: datetime.now(tz=UTC))
        self.denials: list[AuthorityDenial] = []
        self.egress_attempts: list[EgressAttempt] = []

    def open_research_page(
        self,
        page_url: str,
        privileged_sessions: dict[str, str],
    ) -> BrowsingContext:
        """Open an untrusted page without access to privileged sessions."""
        _ = privileged_sessions
        return BrowsingContext(
            page_origin=_origin_from_url(page_url),
            privileged=False,
            available_session_services=frozenset(),
        )

    def open_privileged_page(self, page_url: str, service: str) -> BrowsingContext:
        """Open a page that may use one named privileged session."""
        return BrowsingContext(
            page_origin=_origin_from_url(page_url),
            privileged=True,
            available_session_services=frozenset({service}),
        )

    def session_for_context(
        self,
        context: BrowsingContext,
        service: str,
        privileged_sessions: dict[str, str],
    ) -> str | None:
        """Return a session secret only when the context may use it."""
        if not context.privileged:
            return None
        if service not in context.available_session_services:
            return None
        return privileged_sessions.get(service)

    def evaluate_operation(
        self,
        grant: TaskAuthorityGrant,
        operation: RequestedOperation,
    ) -> ApprovalDecision:
        """Deny operations that exceed the task grant."""
        if operation.action_type == "browse" and operation.destination:
            browse_origin = _origin_from_url(operation.destination)
            if browse_origin not in grant.approved_origins:
                return self._deny(
                    f"browsing {browse_origin!r} is outside approved origins",
                    operation,
                )
            return ApprovalDecision.ALLOW

        if operation.action_type == "upload_workspace" and not grant.allow_workspace_upload:
            return self._deny(
                "workspace upload not granted by task",
                operation,
                record_egress=operation.destination is not None,
            )

        if operation.action_type == "send" and not grant.allow_messaging:
            return self._deny(
                "messaging not granted by task",
                operation,
                record_egress=operation.destination is not None,
            )

        if operation.destination and not grant.allow_external_recipient:
            return self._deny(
                "external recipient not granted by task",
                operation,
                record_egress=True,
            )

        if operation.destination:
            destination_origin = _destination_origin(operation.destination)
            if (
                destination_origin is not None
                and destination_origin not in grant.approved_origins
            ):
                return self._deny(
                    f"destination {destination_origin!r} is not an approved origin",
                    operation,
                    record_egress=True,
                )

        return ApprovalDecision.ALLOW

    def _deny(
        self,
        reason: str,
        operation: RequestedOperation,
        *,
        record_egress: bool = False,
    ) -> ApprovalDecision:
        self.denials.append(
            AuthorityDenial(
                reason=reason,
                operation=operation,
                recorded_at=self._now(),
            )
        )
        if record_egress and operation.destination:
            self.egress_attempts.append(
                EgressAttempt(
                    destination=operation.destination,
                    payload=operation.payload or "",
                    blocked=True,
                )
            )
        return ApprovalDecision.DENY


def _origin_from_url(url: str) -> str:
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = parsed.netloc or parsed.path.split("/", 1)[0]
    scheme = parsed.scheme or "https"
    return f"{scheme}://{host}"


def _destination_origin(destination: str) -> str | None:
    if "@" in destination and "://" not in destination:
        return None
    if "://" in destination or destination.startswith("//"):
        return _origin_from_url(destination)
    if "." in destination:
        return _origin_from_url(destination)
    return None
