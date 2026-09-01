"""Canonical org-scoped HTTP path builders."""

from __future__ import annotations


def org_path(tenant_id: str, suffix: str) -> str:
    """Return /orgs/{tenant_id}{suffix} with a leading slash on suffix."""
    if not suffix.startswith("/"):
        suffix = f"/{suffix}"
    return f"/orgs/{tenant_id}{suffix}"
