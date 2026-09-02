"""Static checks that live tooling does not resurrect X-Tenant-Id."""

from __future__ import annotations

from pathlib import Path

_FORBIDDEN = "X-Tenant-Id"
_ROOT = Path(__file__).resolve().parents[1]
_PATHS = (
    _ROOT / "scripts" / "chatticus_chat.py",
    _ROOT / "src" / "chatticus" / "thin_turn_conversation.py",
)


def test_live_tooling_does_not_reference_x_tenant_id_header() -> None:
    offenders: list[str] = []
    for path in _PATHS:
        text = path.read_text()
        if _FORBIDDEN in text:
            offenders.append(str(path.relative_to(_ROOT)))
    assert offenders == []
