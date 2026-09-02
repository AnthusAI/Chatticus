"""Unit tests for the org-scoped path helper."""

from __future__ import annotations

from chatticus.http.paths import org_path


def test_org_path_prefixes_tenant() -> None:
    assert org_path("anthus", "/channels") == "/orgs/anthus/channels"
    assert org_path("anthus", "channels") == "/orgs/anthus/channels"
