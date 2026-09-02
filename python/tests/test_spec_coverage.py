"""Unit tests for spec coverage heuristic helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from spec_coverage import (  # noqa: E402
    corpus_mentions_route,
    flexible_static_segments_pattern,
    normalize_path_suffix,
    repo_root_from_script,
    static_path_segments,
    trailing_static_fragment,
)


def test_repo_root_from_script() -> None:
    script = _SCRIPTS_DIR / "spec_coverage.py"
    repo_root = repo_root_from_script(script)
    assert (repo_root / "features").is_dir()
    assert (repo_root / "python" / "src" / "chatticus").is_dir()


def test_normalize_path_suffix_strips_org_prefix() -> None:
    path = "/orgs/{tenant_id}/turns/{turn_id}/grant"
    assert normalize_path_suffix(path) == "/turns/{turn_id}/grant"
    assert normalize_path_suffix("/me") == "/me"


def test_static_path_segments_ignores_params() -> None:
    assert static_path_segments("/turns/{turn_id}/grant") == ["turns", "grant"]
    assert static_path_segments("/users/{user_id}/bots") == ["users", "bots"]


def test_trailing_static_fragment() -> None:
    assert (
        trailing_static_fragment("/turns/{turn_id}/workspace/read") == "/workspace/read"
    )
    assert trailing_static_fragment("/workers/register") == "/workers/register"
    assert trailing_static_fragment("/me") == "/me"


def test_flexible_static_segments_pattern() -> None:
    pattern = flexible_static_segments_pattern(
        "/orgs/{tenant_id}/turns/{turn_id}/grant"
    )
    assert pattern is not None
    assert pattern.search('org_path(tenant, "/turns/foo/grant")')


@pytest.mark.parametrize(
    ("corpus", "path", "expected"),
    [
        ('client.get("/health")', "/health", True),
        ("the service is healthy", "/health", False),
        ("GET /me", "/me", True),
        ("remember me later", "/me", False),
        (
            'org_path(t, "/turns/{turn_id}/grant")',
            "/orgs/{tenant_id}/turns/{turn_id}/grant",
            True,
        ),
        (
            '"/turns/{turn_id}/workspace/read"',
            "/orgs/{tenant_id}/turns/{turn_id}/workspace/read",
            True,
        ),
        ("unrelated text", "/orgs/{tenant_id}/bots/{bot_id}/memory", False),
    ],
)
def test_corpus_mentions_route(corpus: str, path: str, expected: bool) -> None:
    assert corpus_mentions_route(corpus, path) is expected
