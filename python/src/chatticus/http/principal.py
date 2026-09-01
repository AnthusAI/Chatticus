"""Principal dependency seam and waitlist-safe route marker."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Final

from fastapi import Depends, Request

from chatticus.models import OrganizationStatus
from chatticus.principal import Principal, PrincipalKind

if TYPE_CHECKING:
    from chatticus.control_plane import ControlPlane

_PRINCIPAL_POLICY_ATTR: Final = "__chatticus_principal_policy__"

# Routes that never participate in principal resolution or the marker system.
NO_PRINCIPAL_ROUTES: Final[frozenset[str]] = frozenset({"/health"})
NO_PRINCIPAL_ROUTE_PREFIXES: Final[tuple[str, ...]] = ("/auth/",)

# Waitlist-safe routes are opt-out: each path must be named explicitly.
WAITLIST_SAFE_ROUTE_PATHS: Final[frozenset[str]] = frozenset({"/me"})


@dataclass(frozen=True)
class PrincipalRoutePolicy:
    """Access policy for one route that resolves a principal."""

    waitlist_safe: bool = False

    @property
    def requires_enabled_member(self) -> bool:
        """True when only enabled members may call this route."""
        return not self.waitlist_safe


def is_no_principal_route(path: str) -> bool:
    """Return whether *path* is outside the principal marker system."""
    return path in NO_PRINCIPAL_ROUTES or path.startswith(NO_PRINCIPAL_ROUTE_PREFIXES)


def principal_route_policy(route_handler: object) -> PrincipalRoutePolicy:
    """Return the principal policy declared on *route_handler*."""
    policy = getattr(route_handler, _PRINCIPAL_POLICY_ATTR, None)
    if policy is None:
        return PrincipalRoutePolicy()
    if not isinstance(policy, PrincipalRoutePolicy):
        raise TypeError(
            f"Expected PrincipalRoutePolicy on {route_handler!r}, got {type(policy)!r}."
        )
    return policy


def waitlist_safe[T](route_handler: T) -> T:
    """Mark one route reachable by a waitlisted member."""
    setattr(
        route_handler, _PRINCIPAL_POLICY_ATTR, PrincipalRoutePolicy(waitlist_safe=True)
    )
    return route_handler


async def resolve_principal(request: Request) -> Principal:
    """Resolve the authenticated principal for *request*.

    Resolver implementations land in a later task; this seam defines the
    dependency shape only.
    """
    raise NotImplementedError("Principal resolver is not wired yet.")


RequirePrincipal = Annotated[Principal, Depends(resolve_principal)]


class OrgAccessDeniedError(Exception):
    """Raised when a principal may not access the organization in the path."""


def verify_org_access(
    principal: Principal,
    path_tenant_id: str,
    *,
    policy: PrincipalRoutePolicy,
    plane: ControlPlane,
) -> None:
    """Check that *principal* may access *path_tenant_id* under *policy*."""
    if principal.kind == PrincipalKind.WORKER:
        if principal.tenant_id != path_tenant_id:
            raise OrgAccessDeniedError(
                f"Worker {principal.worker_id!r} is not registered for "
                f"organization {path_tenant_id!r}."
            )
        return

    if principal.user_id is None:
        raise OrgAccessDeniedError("User principal is missing user_id.")

    membership = plane.get_membership(path_tenant_id, principal.user_id)
    if membership is None:
        raise OrgAccessDeniedError(
            f"User {principal.user_id!r} is not a member of "
            f"organization {path_tenant_id!r}."
        )

    organization = plane.get_organization(path_tenant_id)
    if policy.requires_enabled_member:
        if organization.status != OrganizationStatus.ENABLED:
            raise OrgAccessDeniedError(
                f"Organization {path_tenant_id!r} has status "
                f"{organization.status!r}; enabled membership is required."
            )
