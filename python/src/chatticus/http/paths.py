"""Canonical org-scoped HTTP path builders."""

from __future__ import annotations


def org_path(tenant_id: str, suffix: str) -> str:
    """Return /orgs/{tenant_id}{suffix} with a leading slash on suffix."""
    if not suffix.startswith("/"):
        suffix = f"/{suffix}"
    return f"/orgs/{tenant_id}{suffix}"


def org_self_setup_cross_account_role_path(tenant_id: str) -> str:
    """Return the customer self-setup cross-account role submission path."""
    return org_path(tenant_id, "/self-setup/cross-account-role")


def org_monthly_aws_spend_ceiling_path(tenant_id: str) -> str:
    """Return the owner monthly AWS spend ceiling update path."""
    return org_path(tenant_id, "/monthly-aws-spend-ceiling")


def operator_org_path(tenant_id: str, action: str) -> str:
    """Return /operator/orgs/{tenant_id}/{action} for lifecycle mutations."""
    return f"/operator/orgs/{tenant_id}/{action}"
