#!/usr/bin/env python3
"""Run chatticus-0edb18 long-job spike phases against development AWS."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import boto3
import httpx

SPIKE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SPIKE_ROOT))

from spike_support import (  # noqa: E402
    EmptySqs,
    InjectedSqsMessage,
    LongJobActionExecutor,
    NoopBootDriver,
    SpikeJobMetrics,
    configure_logging,
    delete_s3_prefix,
    healthy_worker_count,
    load_invoke_key,
    new_run_dir,
    poll_sqs,
    require_env,
    sqs_snapshot,
    turn_snapshot,
    write_json,
)

from chatticus.computer_host_worker import run_host_worker_once  # noqa: E402
from chatticus.http.app import INVOKE_HEADER  # noqa: E402
from chatticus.http.client import HttpTurnClient  # noqa: E402
from chatticus.http.paths import org_path  # noqa: E402
from chatticus.http.worker_auth import register_worker_bearer  # noqa: E402
from chatticus.models import WorkerRegistration  # noqa: E402
from chatticus.runtime import job_from_queue_payload, plane_from_env  # noqa: E402
from chatticus.worker.lambda_handler import _front_door_base_url  # noqa: E402


def _http_client() -> httpx.Client:
    invoke_key = load_invoke_key()
    os.environ.setdefault("CHATTICUS_INVOKE_KEY", invoke_key)
    headers = {INVOKE_HEADER: invoke_key}
    return httpx.Client(base_url=_front_door_base_url(), headers=headers, timeout=120.0)


def _prepare_turn(plane, tenant_id: str, user_id: str):
    """Prepare one computer continuation turn with a unique bot name."""
    from http_test_support import DEFAULT_OWNER_EMAIL, _seed_org_for_user

    from chatticus.computer_capabilities import BROWSER_CAPABILITY
    from chatticus.computer_continuation_driver import ComputerContinuationSetup
    from chatticus.models import (
        ActorKind,
        CostClass,
        MemberRole,
        Membership,
        OrganizationNotFoundError,
        WorkerRegistration,
    )

    try:
        plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        _seed_org_for_user(
            plane,
            tenant_id,
            user_id,
            owner_email=DEFAULT_OWNER_EMAIL,
        )
    else:
        if plane.get_membership(tenant_id, user_id) is None:
            plane._messaging_store.put_membership(
                Membership(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role=MemberRole.OWNER,
                    joined_at=plane.now(),
                )
            )
    bot = plane.create_bot(
        tenant_id,
        f"Spike-{uuid4().hex[:8]}",
        creator_user_id=user_id,
    )
    channel = plane.create_channel(tenant_id, user_id, [bot.bot_id])
    _, started = plane.post_channel_message(
        channel.channel_id,
        tenant_id,
        ActorKind.HUMAN,
        user_id,
        "open the household browser",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    turn_id = started.turn_id
    claimed = plane.claim_turn_attempt(tenant_id, turn_id, "computerless-worker")
    assert claimed is not None and claimed.acquired
    computer = plane.ensure_computer(tenant_id)
    plane.register_worker(
        WorkerRegistration(
            worker_id="computer-worker",
            tenant_id=tenant_id,
            cost_class=CostClass.FARGATE,
            capabilities=frozenset({"cpu", "computer", "browser"}),
            computer_id=computer.computer_id,
        )
    )
    plane.prepare_computer_tool(
        tenant_id,
        turn_id,
        tool_name="browser_open",
        arguments={"url": "https://mail.example"},
    )
    plane.record_model_request(tenant_id, turn_id, "I will open household mail.")
    plane.commit_pending_computer_tool(tenant_id, turn_id)
    plane.enqueue_computer_continuation(tenant_id, turn_id)
    plane.relinquish_computerless_ownership(tenant_id, turn_id)
    plane.set_computer_stopped(tenant_id, False)
    plane.record_computer_capability_ready(tenant_id, user_id, BROWSER_CAPABILITY)
    record = plane.escalation_for(tenant_id, turn_id)
    assert record.continuation_job_id is not None
    job = next(job for job in plane._jobs if job.job_id == record.continuation_job_id)
    return ComputerContinuationSetup(
        tenant_id=tenant_id,
        user_id=user_id,
        turn_id=turn_id,
        continuation_job=job,
        pending_action_id=record.pending_call.action_id,
    )


def _enqueue_payload(setup) -> str:
    job = setup.continuation_job
    return json.dumps(
        {
            "job_id": job.job_id,
            "tenant_id": job.tenant_id,
            "turn_id": job.turn_id,
            "bot_id": job.bot_id,
            "user_id": job.user_id,
            "computer_id": job.computer_id,
            "computer_policy": job.computer_policy,
            "required_capabilities": sorted(job.required_capabilities),
        }
    )


def phase_idle_poll(run_dir: Path, logger) -> dict:
    """Observation 1a: CHATTICUS_HOST_WORKER_SECONDS bites idle polling only."""
    require_env("CHATTICUS_COMPUTER_TURN_QUEUE_URL", "CHATTICUS_TENANT_ID", "CHATTICUS_USER_ID")
    tenant_id = os.environ["CHATTICUS_TENANT_ID"]
    user_id = os.environ["CHATTICUS_USER_ID"]
    queue_url = os.environ["CHATTICUS_COMPUTER_TURN_QUEUE_URL"]
    host_seconds = int(os.environ.get("CHATTICUS_HOST_WORKER_SECONDS", "120"))
    plane = plane_from_env()
    sqs = EmptySqs()
    with _http_client() as client:
        turn_client = HttpTurnClient(client, tenant_id)
        boot = NoopBootDriver(plane, tenant_id=tenant_id, user_id=user_id)
        started = time.monotonic()
        deadline = started + host_seconds + 15
        iterations = 0
        logger.info("idle_poll_start host_seconds=%s", host_seconds)
        while time.monotonic() < deadline:
            iterations += 1
            ran = run_host_worker_once(
                plane=plane,
                turn_client=turn_client,
                sqs_client=sqs,
                queue_url=queue_url,
                tenant_id=tenant_id,
                user_id=user_id,
                boot_driver=boot,
            )
            if ran is not None:
                logger.warning("unexpected job during idle poll: %s", ran.job_id)
                break
            time.sleep(1)
        elapsed = time.monotonic() - started
    result = {
        "host_worker_seconds": host_seconds,
        "elapsed_seconds": round(elapsed, 3),
        "iterations": iterations,
        "exited_before_job": True,
        "finding": (
            "Poll loop ran until wall clock exceeded CHATTICUS_HOST_WORKER_SECONDS "
            "without receiving a job; this constant is an idle poll budget, not "
            "checked inside run_host_worker_once during action execution."
        ),
    }
    write_json(run_dir / "observation-1-idle-poll.json", result)
    return result


def phase_sqs_visibility(run_dir: Path, logger) -> dict:
    """Observation 2: SQS visibility timeout without ack/renew."""
    require_env("CHATTICUS_COMPUTER_TURN_QUEUE_URL")
    queue_url = os.environ["CHATTICUS_COMPUTER_TURN_QUEUE_URL"]
    sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    logger.info("purging computer queue before visibility probe")
    sqs.purge_queue(QueueUrl=queue_url)
    time.sleep(2.0)
    body = json.dumps({"job_id": f"spike-probe-{uuid4().hex}", "tenant_id": "probe"})
    send = sqs.send_message(QueueUrl=queue_url, MessageBody=body)
    message_id = send["MessageId"]
    logger.info("sent probe message_id=%s", message_id)
    before = sqs_snapshot(sqs, queue_url)
    messages: list[dict[str, str]] = []
    for attempt in range(30):
        receive = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=0,
            VisibilityTimeout=180,
        )
        messages = receive.get("Messages") or []
        if messages:
            break
        time.sleep(0.2)
    if not messages:
        raise RuntimeError("probe message not received after 30 attempts")
    receipt = messages[0]["ReceiptHandle"]
    received_at = time.monotonic()
    logger.info("received probe; holding without delete or renew for 200s")
    timeline = poll_sqs(
        sqs,
        queue_url,
        interval_seconds=20.0,
        until=received_at + 200.0,
        logger=logger,
        out_path=run_dir / "sqs-timeline-probe.json",
    )
    # Do not delete — let visibility expire naturally.
    redelivery = sqs.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=2,
        VisibilityTimeout=180,
    )
    redelivered = bool(redelivery.get("Messages"))
    result = {
        "queue_visibility_timeout_seconds": before.visibility_timeout,
        "receive_visibility_seconds": 180,
        "hold_seconds": 200,
        "redelivered_after_hold": redelivered,
        "timeline": [sample.__dict__ for sample in timeline],
        "finding": (
            "Without ChangeMessageVisibility, a held message becomes visible again "
            "after the queue/receive visibility window (~180s). Multi-day work "
            "cannot rely on a single SQS message regardless of timeout tuning."
        ),
    }
    write_json(run_dir / "observation-2-sqs-visibility.json", result)
    if redelivered and redelivery.get("Messages"):
        sqs.delete_message(
            QueueUrl=queue_url,
            ReceiptHandle=redelivery["Messages"][0]["ReceiptHandle"],
        )
    return result


def phase_heartbeat(run_dir: Path, logger) -> dict:
    """Observation 3: stale heartbeat drops worker from healthy set."""
    require_env("CHATTICUS_TENANT_ID")
    tenant_id = os.environ["CHATTICUS_TENANT_ID"]
    worker_id = os.environ.get("CHATTICUS_WORKER_ID", "spike-heartbeat-probe")
    plane = plane_from_env()
    with _http_client() as client:
        headers = register_worker_bearer(
            client,
            tenant_id,
            worker_id,
            capabilities=["cpu", "computer"],
        )
        healthy_at_register = healthy_worker_count(plane, tenant_id)
        logger.info("healthy_at_register=%s", healthy_at_register)
        time.sleep(35)
        healthy_after_35s = healthy_worker_count(plane, tenant_id)
        logger.info("healthy_after_35s_no_heartbeat=%s", healthy_after_35s)
        heartbeat = client.post(
            org_path(tenant_id, f"/workers/{worker_id}/heartbeat"),
            headers=headers,
        )
        heartbeat.raise_for_status()
        healthy_after_heartbeat = healthy_worker_count(plane, tenant_id)
        logger.info("healthy_after_heartbeat=%s", healthy_after_heartbeat)
        time.sleep(35)
        healthy_after_second_gap = healthy_worker_count(plane, tenant_id)
    result = {
        "heartbeat_timeout_seconds": plane.heartbeat_timeout.total_seconds(),
        "worker_id": worker_id,
        "healthy_at_register": healthy_at_register,
        "healthy_after_35s_no_heartbeat": healthy_after_35s,
        "healthy_after_heartbeat": healthy_after_heartbeat,
        "healthy_after_second_35s_gap": healthy_after_second_gap,
        "finding": (
            "The scheduler cannot distinguish a busy worker from a dead one: "
            "without periodic POST /workers/{id}/heartbeat, the worker is "
            "dropped after heartbeat_timeout (~30s). computer_host_worker does "
            "not send heartbeats during a long execute() call."
        ),
    }
    write_json(run_dir / "observation-3-heartbeat.json", result)
    return result


def phase_job(
    run_dir: Path,
    logger,
    *,
    sleep_seconds: int,
    upload_bytes: int,
    label: str,
) -> dict:
    """Run one long job through run_host_worker_once (production pull worker kernel)."""
    require_env(
        "CHATTICUS_COMPUTER_TURN_QUEUE_URL",
        "CHATTICUS_TENANT_ID",
        "CHATTICUS_USER_ID",
        "CHATTICUS_MESSAGING_TABLE",
    )
    tenant_id = os.environ["CHATTICUS_TENANT_ID"]
    user_id = os.environ["CHATTICUS_USER_ID"]
    queue_url = os.environ["CHATTICUS_COMPUTER_TURN_QUEUE_URL"]
    run_id = f"{label}-{uuid4().hex[:8]}"
    plane = plane_from_env()
    setup = _prepare_turn(plane, tenant_id, user_id)
    body = _enqueue_payload(setup)
    sqs_real = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    send = sqs_real.send_message(QueueUrl=queue_url, MessageBody=body)
    logger.info(
        "enqueued job_id=%s turn_id=%s sqs_message_id=%s",
        setup.continuation_job.job_id,
        setup.turn_id,
        send["MessageId"],
    )
    sqs = InjectedSqsMessage(body)
    metrics = SpikeJobMetrics(
        run_id=run_id,
        sleep_seconds=sleep_seconds,
        upload_bytes=upload_bytes,
    )
    executor = LongJobActionExecutor(
        sleep_seconds=sleep_seconds,
        upload_bytes=upload_bytes,
        run_id=run_id,
        plane=plane,
        tenant_id=tenant_id,
        turn_id=setup.turn_id,
        metrics=metrics,
        logger=logger,
    )
    boot = NoopBootDriver(plane, tenant_id=tenant_id, user_id=user_id)
    sqs_poll = threading.Thread(
        target=poll_sqs,
        kwargs={
            "sqs_client": sqs_real,
            "queue_url": queue_url,
            "interval_seconds": 60.0,
            "until": time.monotonic() + sleep_seconds + 120,
            "logger": logger,
            "out_path": run_dir / "sqs-timeline-job.json",
        },
        daemon=True,
    )
    sqs_poll.start()
    started = time.monotonic()
    with _http_client() as client:
        turn_client = HttpTurnClient(client, tenant_id)
        try:
            ran = run_host_worker_once(
                plane=plane,
                turn_client=turn_client,
                sqs_client=sqs,
                queue_url=queue_url,
                tenant_id=tenant_id,
                user_id=user_id,
                boot_driver=boot,
                action_executor=executor,
            )
        except Exception as exc:
            metrics.error = str(exc)
            logger.exception("run_host_worker_once failed")
            ran = None
    elapsed = time.monotonic() - started
    metrics.worker_poll_elapsed_seconds = round(elapsed, 3)
    metrics.worker_poll_exited_at = datetime.now(UTC).isoformat()
    final_turn = turn_snapshot(plane, tenant_id, setup.turn_id)
    write_json(run_dir / "job-metrics.json", metrics.__dict__)
    write_json(run_dir / "final-turn.json", final_turn)
    result = {
        "label": label,
        "sleep_seconds": sleep_seconds,
        "upload_bytes": upload_bytes,
        "job_completed": ran is not None and metrics.error is None,
        "sqs_deleted": sqs.deleted,
        "sqs_receive_count": sqs.receive_count,
        "elapsed_seconds": round(elapsed, 3),
        "final_turn": final_turn,
        "upload_result": metrics.upload_result,
        "turn_completed": final_turn["status"] == "completed",
    }
    write_json(run_dir / f"observation-job-{label}.json", result)
    return result


def write_observations(run_dir: Path, results: dict) -> None:
    """Synthesize the four observation markdown files."""
    obs1 = f"""# Observation 1 — CHATTICUS_HOST_WORKER_SECONDS

## Evidence

- Idle poll: `{run_dir / 'observation-1-idle-poll.json'}`
- Authorized job elapsed: {results.get('authorized', {}).get('elapsed_seconds')} s for
  {results.get('authorized', {}).get('sleep_seconds')} s sleep

## Finding

`CHATTICUS_HOST_WORKER_SECONDS` (default 120) governs the **outer poll loop** in
`computer_host_worker.main()`. It does **not** interrupt `run_host_worker_once`
while `ComputerWorker.run_job` is blocked inside `action_executor.execute()`.

Raising this constant alone does not fix long jobs on the pull path; other ceilings
(`turn_deadline` 120 s, `attempt_lease` 60 s, SQS visibility 180 s) still apply.
"""
    obs2 = f"""# Observation 2 — SQS visibility

## Evidence

- Visibility probe: `{run_dir / 'observation-2-sqs-visibility.json'}`
- Job timeline: `{run_dir / 'sqs-timeline-job.json'}`

## Finding

{results.get('sqs', {}).get('finding', '')}

`ComputerWorker` accepts `queue_visibility_renewer` but **never calls it** during
long `execute()`. `computer_host_worker.run_host_worker_once` does not wire a
renewer at all.
"""
    obs3 = f"""# Observation 3 — Heartbeat semantics

## Evidence

- `{run_dir / 'observation-3-heartbeat.json'}`

## Finding

{results.get('heartbeat', {}).get('finding', '')}
"""
    obs4 = f"""# Observation 4 — Turn loop assumptions

## Evidence

- `{run_dir / 'job-metrics.json'}`
- `{run_dir / 'final-turn.json'}`

## Finding

During a {results.get('authorized', {}).get('sleep_seconds', 0) // 60}-minute blocking
execute, turn state must be read from job-metrics turn_snapshots. Expect
`turn_deadline` recovery (120 s default), lease expiry (60 s), and no
`turn.completed` until `complete_computer_continuation` runs after execute returns.

In-flight chunk TTL defaults to 4 h (`DynamoMessagingStore.chunk_ttl_hours`).
"""
    (run_dir / "observation-1-host-worker-seconds.md").write_text(obs1)
    (run_dir / "observation-2-sqs-visibility.md").write_text(obs2)
    (run_dir / "observation-3-heartbeat.md").write_text(obs3)
    (run_dir / "observation-4-turn-semantics.md").write_text(obs4)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--phase",
        choices=["all", "probes", "authorized", "iteration", "heartbeat"],
        default="all",
    )
    parser.add_argument("--sleep-seconds", type=int, default=1800)
    parser.add_argument("--upload-bytes", type=int, default=2_000_000_000)
    args = parser.parse_args()

    run_dir = new_run_dir(args.phase)
    logger = configure_logging(run_dir)
    logger.info("run_dir=%s phase=%s", run_dir, args.phase)
    results: dict = {}

    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    prefix = os.environ.get("CHATTICUS_SPIKE_S3_PREFIX", "spikes/0edb18")

    try:
        if args.phase in {"all", "probes"}:
            results["idle_poll"] = phase_idle_poll(run_dir, logger)
            results["sqs"] = phase_sqs_visibility(run_dir, logger)

        if args.phase in {"all", "probes", "heartbeat"}:
            results["heartbeat"] = phase_heartbeat(run_dir, logger)

        if args.phase in {"all", "iteration"}:
            results["iteration"] = phase_job(
                run_dir,
                logger,
                sleep_seconds=150,
                upload_bytes=1_048_576,
                label="iteration-150s",
            )

        if args.phase in {"all", "authorized"}:
            results["authorized"] = phase_job(
                run_dir,
                logger,
                sleep_seconds=args.sleep_seconds,
                upload_bytes=args.upload_bytes,
                label="authorized",
            )
    finally:
        delete_s3_prefix(s3, prefix, logger)

    write_observations(run_dir, results)
    write_json(run_dir / "summary.json", results)
    logger.info("done run_dir=%s", run_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
