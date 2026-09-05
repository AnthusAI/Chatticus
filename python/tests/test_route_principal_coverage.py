"""Route-level principal enforcement coverage for the HTTP front door."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import pytest
from cognito_test_support import make_cognito_test_keys, mint_id_token
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path
from chatticus.http.principal import (
    enforce_operator_principal,
    enforce_user_principal,
    enforce_worker_principal,
    is_no_principal_route,
    is_worker_bootstrap_route,
    is_worker_route_path,
)
from chatticus.org_records import ANTHUS_TENANT_ID

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)

ORG_SCOPED_PREFIX = "/orgs/{tenant_id}/"
OPERATOR_PREFIX = "/operator/"
WORKER_REGISTER_ROUTE = ("POST", f"{ORG_SCOPED_PREFIX}workers/register")
PRINCIPAL_ENFORCERS: frozenset[Callable[..., object]] = frozenset(
    {
        enforce_user_principal,
        enforce_worker_principal,
        enforce_operator_principal,
    }
)
PRINCIPAL_ENFORCER_NAMES: frozenset[str] = frozenset(
    {enforcer.__name__ for enforcer in PRINCIPAL_ENFORCERS}
)


def _full_route_path(route: APIRoute, parent_prefix: str) -> str:
    if route.path.startswith("/orgs/") or route.path.startswith("/operator/"):
        return route.path
    return f"{parent_prefix.rstrip('/')}{route.path}"


def _iter_api_routes(
    app: FastAPI, *, path_prefix: str
) -> Iterator[tuple[APIRoute, str]]:
    """Yield every APIRoute under *path_prefix* and its fully qualified path."""

    def walk(
        router_routes: list[object], prefix: str = ""
    ) -> Iterator[tuple[APIRoute, str]]:
        for route in router_routes:
            if isinstance(route, APIRoute):
                path = _full_route_path(route, prefix)
                if path.startswith(path_prefix):
                    yield route, path
                continue
            original_router = getattr(route, "original_router", None)
            if original_router is not None:
                child_prefix = f"{prefix}{original_router.prefix or ''}"
                yield from walk(original_router.routes, child_prefix)
                continue
            nested_routes = getattr(route, "routes", None)
            if nested_routes is not None:
                yield from walk(nested_routes, prefix)

    yield from walk(app.router.routes)


def _iter_org_api_routes(app: FastAPI) -> Iterator[tuple[APIRoute, str]]:
    """Yield every org-scoped APIRoute and its fully qualified path."""
    yield from _iter_api_routes(app, path_prefix=ORG_SCOPED_PREFIX)


def _iter_operator_api_routes(app: FastAPI) -> Iterator[tuple[APIRoute, str]]:
    """Yield every operator APIRoute and its fully qualified path."""
    yield from _iter_api_routes(app, path_prefix=OPERATOR_PREFIX)


def _dependency_callables(
    dependant: object, seen: set[int] | None = None
) -> list[Callable[..., object]]:
    if seen is None:
        seen = set()
    dependant_id = id(dependant)
    if dependant_id in seen:
        return []
    seen.add(dependant_id)

    callables: list[Callable[..., object]] = []
    call = getattr(dependant, "call", None)
    if callable(call):
        callables.append(call)
    for child in getattr(dependant, "dependencies", []) or []:
        callables.extend(_dependency_callables(child, seen))
    return callables


def _route_has_principal_enforcer(route: APIRoute) -> bool:
    for call in _dependency_callables(route.dependant):
        if call in PRINCIPAL_ENFORCERS:
            return True
        if getattr(call, "__name__", "") in PRINCIPAL_ENFORCER_NAMES:
            return True
    return False


def _route_has_operator_enforcer(route: APIRoute) -> bool:
    for call in _dependency_callables(route.dependant):
        if call is enforce_operator_principal:
            return True
        if getattr(call, "__name__", "") == enforce_operator_principal.__name__:
            return True
    return False


def _test_app() -> FastAPI:
    keys = make_cognito_test_keys()
    return create_app(
        ControlPlane(),
        invoke_key="",
        operator_key="test-operator-secret",
        cognito_verifier=keys.verifier(),
    )


def test_all_org_scoped_routes_wire_a_principal_enforcer() -> None:
    app = _test_app()
    org_routes = list(_iter_org_api_routes(app))
    assert org_routes, "expected at least one org-scoped route"

    exempt_found = False
    unprotected: list[str] = []
    for route, path in org_routes:
        has_enforcer = _route_has_principal_enforcer(route)
        for method in sorted(route.methods):
            endpoint = (method, path)
            if endpoint == WORKER_REGISTER_ROUTE:
                exempt_found = True
                assert (
                    not has_enforcer
                ), f"{method} {path} is the worker bootstrap route and must stay open"
                continue
            if not has_enforcer:
                unprotected.append(f"{method} {path}")

    assert (
        exempt_found
    ), "POST /orgs/{tenant_id}/workers/register must exist as the open bootstrap route"
    assert not unprotected, "Org routes missing principal enforcer:\n" + "\n".join(
        unprotected
    )


def test_all_operator_routes_wire_a_principal_enforcer() -> None:
    app = _test_app()
    operator_routes = list(_iter_operator_api_routes(app))
    assert operator_routes, "expected at least one operator route"

    unprotected: list[str] = []
    wrong_enforcer: list[str] = []
    for route, path in operator_routes:
        has_operator_enforcer = _route_has_operator_enforcer(route)
        for method in sorted(route.methods):
            endpoint = f"{method} {path}"
            if not has_operator_enforcer:
                if _route_has_principal_enforcer(route):
                    wrong_enforcer.append(endpoint)
                else:
                    unprotected.append(endpoint)

    assert not unprotected, "Operator routes missing principal enforcer:\n" + "\n".join(
        unprotected
    )
    assert not wrong_enforcer, (
        "Operator routes must wire enforce_operator_principal, not another enforcer:\n"
        + "\n".join(wrong_enforcer)
    )


@pytest.mark.parametrize(
    ("path", "method", "expected"),
    [
        ("/health", "GET", True),
        ("/auth/callback", "GET", True),
        (org_path("anthus", "/bots"), "POST", False),
        (org_path("anthus", "/workers/register"), "POST", True),
        (org_path("anthus", "/turns/t1/claim"), "POST", False),
        (org_path("anthus", "/channels/c1/messages"), "POST", False),
        (org_path("anthus", "/turns/t1/stream"), "GET", False),
    ],
)
def test_principal_route_classification(path: str, method: str, expected: bool) -> None:
    if expected:
        assert is_no_principal_route(path) or is_worker_bootstrap_route(
            path, method=method
        )
    else:
        assert not is_no_principal_route(path)
        assert not is_worker_bootstrap_route(path, method=method)


def test_worker_route_paths_are_classified() -> None:
    assert is_worker_route_path(org_path("anthus", "/workers/cpu-1/heartbeat"))
    assert is_worker_route_path(org_path("anthus", "/turns/t1/chunks"))
    assert not is_worker_route_path(org_path("anthus", "/workers/register"))
    assert not is_worker_route_path(org_path("anthus", "/channels"))


def test_user_org_routes_require_cognito_token() -> None:
    keys = make_cognito_test_keys()
    plane = ControlPlane()
    plane.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    client = TestClient(
        create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    )
    for path, payload in (
        (org_path(ANTHUS_TENANT_ID, "/bots"), {"user_id": "ryan", "name": "Helper"}),
        (
            org_path(ANTHUS_TENANT_ID, "/channels"),
            {"user_id": "ryan", "bot_ids": []},
        ),
    ):
        denied = client.post(path, json=payload)
        assert denied.status_code == 403, denied.text
        token = mint_id_token(keys, email="owner@example.com")
        allowed = client.post(
            path,
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert allowed.status_code == 200, allowed.text


def test_worker_register_stays_open_without_user_or_worker_principal() -> None:
    keys = make_cognito_test_keys()
    plane = ControlPlane()
    client = TestClient(
        create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    )
    response = client.post(
        org_path(ANTHUS_TENANT_ID, "/workers/register"),
        json={
            "worker_id": "exercise-worker",
            "cost_class": "local",
            "capabilities": ["cpu"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["token"]
