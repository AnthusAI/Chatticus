"""Principal dependency seam and waitlist-safe route marker."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Final

from fastapi import Depends, HTTPException, Request

from chatticus.cognito_jwt import CognitoJwtVerifier, CognitoTokenError
from chatticus.models import (
    IdentityNotFoundError,
    MemberRole,
    Membership,
    MembershipNotFoundError,
    OrganizationStatus,
)
from chatticus.principal import Principal, PrincipalKind
from chatticus.worker_credentials import parse_bearer_token

if TYPE_CHECKING:
    from chatticus.control_plane import ControlPlane

_PRINCIPAL_POLICY_ATTR: Final = "__chatticus_principal_policy__"
_WORKER_ROUTE_ATTR: Final = "__chatticus_worker_route__"

# Routes that never participate in principal resolution or the marker system.
NO_PRINCIPAL_ROUTES: Final[frozenset[str]] = frozenset({"/health"})
NO_PRINCIPAL_ROUTE_PREFIXES: Final[tuple[str, ...]] = ("/auth/",)

# Waitlist-safe routes are opt-out: each path must be named explicitly.
WAITLIST_SAFE_ROUTE_PATHS: Final[frozenset[str]] = frozenset({"/me"})


class PrincipalAudience(StrEnum):
    """Which caller kind may reach a route."""

    USER = "user"
    WORKER = "worker"


@dataclass(frozen=True)
class PrincipalRoutePolicy:
    """Access policy for one route that resolves a principal."""

    waitlist_safe: bool = False
    audience: PrincipalAudience = PrincipalAudience.USER

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


def is_worker_route(route_handler: object) -> bool:
    """Return whether *route_handler* requires a worker bearer credential."""
    return bool(getattr(route_handler, _WORKER_ROUTE_ATTR, False))


def waitlist_safe[T](route_handler: T) -> T:
    """Mark one route reachable by a waitlisted member."""
    setattr(
        route_handler, _PRINCIPAL_POLICY_ATTR, PrincipalRoutePolicy(waitlist_safe=True)
    )
    return route_handler


def worker_route[T](route_handler: T) -> T:
    """Mark one route as worker-only and requiring a bearer credential."""
    setattr(route_handler, _WORKER_ROUTE_ATTR, True)
    setattr(
        route_handler,
        _PRINCIPAL_POLICY_ATTR,
        PrincipalRoutePolicy(audience=PrincipalAudience.WORKER),
    )
    return route_handler


def resolve_worker_principal_from_token(
    plane: ControlPlane,
    tenant_id: str,
    token: str,
) -> Principal:
    """Map one bearer token to a worker principal for *tenant_id*."""
    worker_id = plane.verify_worker_token(tenant_id, token)
    if worker_id is None:
        raise HTTPException(status_code=403, detail="invalid worker credential")
    return Principal(
        kind=PrincipalKind.WORKER,
        tenant_id=tenant_id,
        worker_id=worker_id,
    )


# Warm-life cache: membership rows for one Lambda container.
_MEMBERSHIP_CACHE: dict[
    tuple[str, str], tuple[Membership, OrganizationStatus, MemberRole]
] = {}


def resolve_user_principal_from_token(
    plane: ControlPlane,
    tenant_id: str,
    token: str,
    *,
    verifier: CognitoJwtVerifier,
) -> Principal:
    """Map one Cognito id_token to a user principal for *tenant_id*.

    Identity is keyed on verified email from the id_token, never Cognito sub.
    Organization status and role come from DynamoDB membership rows, not token
    claims.

    SSE (7b4616): validate once when the stream opens; each reconnect is a new
    HTTP request and must carry a fresh id_token. Do not re-validate mid-stream
    — a revoked or suspended member may keep receiving until turn completion.
    """
    verified = verifier.verify_id_token(token)
    identity = plane.get_identity_by_email(verified.email)
    if identity is None:
        raise IdentityNotFoundError(
            f"No identity is registered for email {verified.email!r}."
        )

    cache_key = (tenant_id, identity.user_id)
    cached = _MEMBERSHIP_CACHE.get(cache_key)
    if cached is None:
        membership = plane.get_membership(tenant_id, identity.user_id)
        if membership is None:
            raise MembershipNotFoundError(
                f"User {identity.user_id!r} is not a member of "
                f"organization {tenant_id!r}."
            )
        organization = plane.get_organization(tenant_id)
        cached = (membership, organization.status, membership.role)
        _MEMBERSHIP_CACHE[cache_key] = cached
    membership, organization_status, role = cached
    return Principal(
        kind=PrincipalKind.USER,
        tenant_id=tenant_id,
        user_id=identity.user_id,
        organization_status=organization_status,
        role=role,
    )


async def resolve_user_bearer(
    request: Request,
    tenant_id: str,
    *,
    verifier: CognitoJwtVerifier,
) -> Principal:
    """Resolve a Cognito id_token to a user principal for one org-scoped route."""
    token = parse_bearer_token(request.headers.get("Authorization"))
    if token is None:
        raise HTTPException(status_code=403, detail="user credential required")
    plane: ControlPlane = request.app.state.chatticus.plane
    try:
        return resolve_user_principal_from_token(
            plane, tenant_id, token, verifier=verifier
        )
    except CognitoTokenError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except IdentityNotFoundError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except MembershipNotFoundError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error


async def resolve_worker_bearer(request: Request, tenant_id: str) -> Principal:
    """Resolve a bearer token to a principal for one org-scoped worker route."""
    token = parse_bearer_token(request.headers.get("Authorization"))
    if token is None:
        raise HTTPException(status_code=403, detail="worker credential required")
    plane: ControlPlane = request.app.state.chatticus.plane
    return resolve_worker_principal_from_token(plane, tenant_id, token)


async def require_worker_principal(request: Request, tenant_id: str) -> Principal:
    """Require a valid worker bearer credential for one org-scoped route."""
    principal = await resolve_worker_bearer(request, tenant_id)
    if principal.kind != PrincipalKind.WORKER:
        raise HTTPException(status_code=403, detail="worker credential required")
    return principal


async def reject_worker_credential(request: Request, tenant_id: str) -> None:
    """Reject browser routes that present a valid worker bearer credential."""
    token = parse_bearer_token(request.headers.get("Authorization"))
    if token is None:
        return
    plane: ControlPlane = request.app.state.chatticus.plane
    if plane.verify_worker_token(tenant_id, token) is not None:
        raise HTTPException(
            status_code=403,
            detail="worker credential not accepted on this route",
        )


RequireWorkerPrincipal = Annotated[Principal, Depends(require_worker_principal)]


async def resolve_principal(request: Request) -> Principal:
    """Resolve the authenticated principal for *request*.

    User JWT resolution is implemented in a later task. This seam exists
    for tests and the phase-4 enforcement join.
    """
    raise NotImplementedError("Principal resolver is not wired yet.")


RequirePrincipal = Annotated[Principal, Depends(resolve_principal)]


class OrgAccessDeniedError(Exception):
    """Raised when a principal may not access the organization in the path."""


class PrincipalAudienceDeniedError(Exception):
    """Raised when the principal kind does not match the route audience."""


def verify_principal_audience(
    principal: Principal,
    *,
    audience: PrincipalAudience,
) -> None:
    """Check that *principal* matches the declared route *audience*."""
    if audience == PrincipalAudience.WORKER and principal.kind != PrincipalKind.WORKER:
        raise PrincipalAudienceDeniedError("This route requires a worker credential.")
    if audience == PrincipalAudience.USER and principal.kind != PrincipalKind.USER:
        raise PrincipalAudienceDeniedError(
            "This route does not accept a worker credential."
        )


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
