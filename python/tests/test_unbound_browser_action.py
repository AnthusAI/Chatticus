"""Kernel tests for unbound authenticated browser consequential actions."""

from __future__ import annotations

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.overnight_gated import USER_CONTROLLED_COMPLETION_REQUIRED


@pytest.mark.parametrize(
    "action",
    ["send", "publish", "purchase", "delete", "change production"],
)
def test_unbound_browser_consequential_actions_stop(action: str) -> None:
    plane = ControlPlane()
    result = plane.attempt_authenticated_browser_action(action)
    assert result.executed is False
    assert result.reason == USER_CONTROLLED_COMPLETION_REQUIRED


def test_binding_control_is_not_this_path() -> None:
    plane = ControlPlane()
    with pytest.raises(ValueError, match="binding control"):
        plane.attempt_authenticated_browser_action(
            "send",
            structured_connector=True,
        )
