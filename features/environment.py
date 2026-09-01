"""Behave environment for Chatticus control-plane specs."""

from __future__ import annotations

import shutil
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server

_TESTS_DIR = Path(__file__).resolve().parents[1] / "python" / "tests"
if _TESTS_DIR.is_dir() and str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))


def before_scenario(context: object, scenario: object) -> None:
    """Start each scenario with a fresh control plane and temp dirs."""
    context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    app = create_app(context.plane, invoke_key="")
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)
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
    context.fence_token = None
    context.message_error = None
    context.other_tenant_id = None
    context.listed_messages = None
    context.sse_watcher = None
    context.access_error = None
    context.stream_error = None
    context.snapshot_tmpdir = tempfile.mkdtemp(prefix="chatticus-snapshot-")


def after_scenario(context: object, scenario: object) -> None:
    """Remove per-scenario snapshot directories."""
    watcher = getattr(context, "sse_watcher", None)
    if watcher is not None:
        watcher.stop()
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()
    snapshot_tmpdir = getattr(context, "snapshot_tmpdir", None)
    if snapshot_tmpdir:
        shutil.rmtree(snapshot_tmpdir, ignore_errors=True)
