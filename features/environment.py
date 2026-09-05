"""Behave environment for Chatticus control-plane specs."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

_TESTS_DIR = Path(__file__).resolve().parents[1] / "python" / "tests"
_STEPS_DIR = Path(__file__).resolve().parent / "steps"
if _STEPS_DIR.is_dir() and str(_STEPS_DIR) not in sys.path:
    sys.path.insert(0, str(_STEPS_DIR))
if _TESTS_DIR.is_dir() and str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from cognito_test_support import make_cognito_test_keys  # noqa: E402

from chatticus.control_plane import ControlPlane  # noqa: E402
from chatticus.email_sender import RecordingEmailSender  # noqa: E402
from chatticus.vendor_prices import clear_vendor_prices  # noqa: E402

_DEPLOYMENT_AWS_ACCOUNT_ID = "111122223333"


def before_scenario(context: object, scenario: object) -> None:
    """Start each scenario with a fresh control plane and temp dirs."""
    from browser_auth_helpers import wire_test_http_front_door

    os.environ["CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID"] = _DEPLOYMENT_AWS_ACCOUNT_ID
    context._caller_account_patch = patch(  # type: ignore[attr-defined]
        "chatticus.org_records.caller_aws_account_id",
        return_value=_DEPLOYMENT_AWS_ACCOUNT_ID,
    )
    context._caller_account_patch.start()  # type: ignore[attr-defined]

    clear_vendor_prices()
    context.email_sender = RecordingEmailSender()
    context.plane = ControlPlane(
        heartbeat_timeout=timedelta(seconds=30),
        email_sender=context.email_sender,
        waitlist_confirmation_base_url="https://hey.chattic.us",
    )
    context.cognito_test_keys = make_cognito_test_keys()
    wire_test_http_front_door(context, context.plane, invoke_key="")
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
    context.seeded_org_emails = {}


def after_scenario(context: object, scenario: object) -> None:
    """Remove per-scenario snapshot directories."""
    caller_patch = getattr(context, "_caller_account_patch", None)
    if caller_patch is not None:
        caller_patch.stop()
    os.environ.pop("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID", None)
    clear_vendor_prices()
    watcher = getattr(context, "sse_watcher", None)
    if watcher is not None:
        watcher.stop()
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()
    snapshot_tmpdir = getattr(context, "snapshot_tmpdir", None)
    if snapshot_tmpdir:
        shutil.rmtree(snapshot_tmpdir, ignore_errors=True)
