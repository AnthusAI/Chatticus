"""Behave environment for Chatticus control-plane specs."""

from __future__ import annotations

from datetime import timedelta

from chatticus.control_plane import ControlPlane


def before_scenario(context: object, scenario: object) -> None:
    """Start each scenario with a fresh control plane."""
    context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    context.bots_by_name = {}
    context.last_job = None
    context.last_assignment = None
    context.last_decision = None
    context.registration_error = None
    context.bot_error = None
