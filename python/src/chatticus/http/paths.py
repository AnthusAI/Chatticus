"""Canonical org-scoped HTTP path builders."""

from __future__ import annotations


def org_path(tenant_id: str, suffix: str) -> str:
    """Return /orgs/{tenant_id}{suffix} with a leading slash on suffix."""
    if not suffix.startswith("/"):
        suffix = f"/{suffix}"
    return f"/orgs/{tenant_id}{suffix}"


def operator_org_path(tenant_id: str, action: str) -> str:
    """Return /operator/orgs/{tenant_id}/{action} for lifecycle mutations."""
    return f"/operator/orgs/{tenant_id}/{action}"
