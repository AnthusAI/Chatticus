"""Behave environment for Chatticus control-plane specs."""

from __future__ import annotations

import shutil
import tempfile
from datetime import timedelta

from chatticus.control_plane import ControlPlane


def before_scenario(context: object, scenario: object) -> None:
    """Start each scenario with a fresh control plane and temp dirs."""
    context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    context.bots_by_name = {}
    context.last_job = None
    context.last_assignment = None
    context.last_decision = None
    context.registration_error = None
    context.bot_error = None
    context.snapshot_error = None
    context.relocate_error = None
    context.hydrate_error = None
    context.write_error = None
    context.last_channel = None
    context.last_message = None
    context.last_turn_id = None
    context.message_error = None
    context.other_tenant_id = None
    context.listed_messages = None
    context.turn_stream = None
    context.access_error = None
    context.stream_error = None
    context.snapshot_tmpdir = tempfile.mkdtemp(prefix="chatticus-snapshot-")


def after_scenario(context: object, scenario: object) -> None:
    """Remove per-scenario snapshot directories."""
    snapshot_tmpdir = getattr(context, "snapshot_tmpdir", None)
    if snapshot_tmpdir:
        shutil.rmtree(snapshot_tmpdir, ignore_errors=True)
