"""Shared helpers for the long-running-job spike."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import boto3

SPIKE_ROOT = Path(__file__).resolve().parent
RESULTS_ROOT = SPIKE_ROOT / "results"

S3_BUCKET = os.environ.get(
    "CHATTICUS_SNAPSHOT_BUCKET",
    "chatticussnapshots-computersnapshotsb892d73f-r8qgykc9zjiq",
)
S3_PREFIX = os.environ.get("CHATTICUS_SPIKE_S3_PREFIX", "spikes/0edb18")


def configure_logging(run_dir: Path) -> logging.Logger:
    """Log to stdout and a run-scoped file."""
    run_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("spike.long_running_job")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    file_handler = logging.FileHandler(run_dir / "run.log")
    file_handler.setFormatter(formatter)
    logger.addHandler(stream)
    logger.addHandler(file_handler)
    return logger


def new_run_dir(phase: str) -> Path:
    """Create a timestamped results directory."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir = RESULTS_ROOT / f"{stamp}-{phase}-{uuid4().hex[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, default=str) + "\n")


@dataclass
class SqsSnapshot:
    """Point-in-time SQS queue attributes."""

    at: str
    visible: str | None
    not_visible: str | None
    visibility_timeout: str | None


def sqs_snapshot(sqs_client: Any, queue_url: str) -> SqsSnapshot:
    response = sqs_client.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=[
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "VisibilityTimeout",
        ],
    )
    attrs = response.get("Attributes") or {}
    return SqsSnapshot(
        at=datetime.now(UTC).isoformat(),
        visible=attrs.get("ApproximateNumberOfMessages"),
        not_visible=attrs.get("ApproximateNumberOfMessagesNotVisible"),
        visibility_timeout=attrs.get("VisibilityTimeout"),
    )


def poll_sqs(
    sqs_client: Any,
    queue_url: str,
    *,
    interval_seconds: float,
    until: float,
    logger: logging.Logger,
    out_path: Path,
) -> list[SqsSnapshot]:
    """Sample queue depth until ``until`` monotonic time."""
    samples: list[SqsSnapshot] = []
    while time.monotonic() < until:
        sample = sqs_snapshot(sqs_client, queue_url)
        samples.append(sample)
        logger.info(
            "sqs visible=%s not_visible=%s visibility_timeout=%s",
            sample.visible,
            sample.not_visible,
            sample.visibility_timeout,
        )
        time.sleep(interval_seconds)
    write_json(out_path, [sample.__dict__ for sample in samples])
    return samples


def turn_snapshot(plane: Any, tenant_id: str, turn_id: str) -> dict[str, Any]:
    turn = plane.turn(tenant_id, turn_id)
    return {
        "at": datetime.now(UTC).isoformat(),
        "turn_id": turn.turn_id,
        "status": turn.status.value,
        "claimed_by_worker_id": turn.claimed_by_worker_id,
        "lease_expires_at": (
            turn.lease_expires_at.isoformat() if turn.lease_expires_at else None
        ),
        "deadline_at": turn.deadline_at.isoformat() if turn.deadline_at else None,
        "recovery_attempts": turn.recovery_attempts,
        "fence_token": turn.fence_token,
        "waiting_for": turn.waiting_for,
        "terminal_reason": turn.terminal_reason,
    }


def healthy_worker_count(plane: Any, tenant_id: str) -> int:
    return len(plane.healthy_workers(tenant_id))


def put_sparse_object(
    s3_client: Any,
    *,
    key: str,
    size_bytes: int,
    logger: logging.Logger,
) -> dict[str, Any]:
    """Create a sparse local file and multipart-upload it."""
    local = SPIKE_ROOT / "tmp" / f"{uuid4().hex}.bin"
    local.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    logger.info("creating sparse file size_bytes=%s path=%s", size_bytes, local)
    with local.open("wb") as handle:
        handle.truncate(size_bytes)
    logger.info("uploading s3://%s/%s", S3_BUCKET, key)
    s3_client.upload_file(str(local), S3_BUCKET, key)
    elapsed = time.monotonic() - started
    local.unlink(missing_ok=True)
    return {
        "bucket": S3_BUCKET,
        "key": key,
        "size_bytes": size_bytes,
        "elapsed_seconds": round(elapsed, 3),
        "at": datetime.now(UTC).isoformat(),
    }


def delete_s3_prefix(s3_client: Any, prefix: str, logger: logging.Logger) -> None:
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
        contents = page.get("Contents") or []
        if not contents:
            continue
        delete = {"Objects": [{"Key": item["Key"]} for item in contents]}
        s3_client.delete_objects(Bucket=S3_BUCKET, Delete=delete)
        logger.info("deleted %s objects under s3://%s/%s", len(contents), S3_BUCKET, prefix)


@dataclass
class SpikeJobMetrics:
    """Timeline markers for one spike job."""

    run_id: str
    sleep_seconds: int
    upload_bytes: int
    sleep_started_at: str | None = None
    sleep_finished_at: str | None = None
    upload_started_at: str | None = None
    upload_finished_at: str | None = None
    upload_result: dict[str, Any] | None = None
    turn_snapshots: list[dict[str, Any]] = field(default_factory=list)
    worker_poll_exited_at: str | None = None
    worker_poll_elapsed_seconds: float | None = None
    error: str | None = None


class NoopBootDriver:
    """Skip Xvfb/Chromium; mark browser capability ready for the spike host."""

    def __init__(self, plane: Any, *, tenant_id: str, user_id: str) -> None:
        self.plane = plane
        self.tenant_id = tenant_id
        self.user_id = user_id

    def boot_through_browser(self) -> None:
        from chatticus.computer_capabilities import BROWSER_CAPABILITY

        self.plane.set_computer_stopped(self.tenant_id, False)
        self.plane.record_computer_capability_ready(
            self.tenant_id, self.user_id, BROWSER_CAPABILITY
        )


class LongJobActionExecutor:
    """Sleep, sample turn state, then PUT a large object to the spike S3 prefix."""

    def __init__(
        self,
        *,
        sleep_seconds: int,
        upload_bytes: int,
        run_id: str,
        plane: Any,
        tenant_id: str,
        turn_id: str,
        metrics: SpikeJobMetrics,
        logger: logging.Logger,
        sample_interval_seconds: float = 30.0,
    ) -> None:
        self.sleep_seconds = sleep_seconds
        self.upload_bytes = upload_bytes
        self.run_id = run_id
        self.plane = plane
        self.tenant_id = tenant_id
        self.turn_id = turn_id
        self.metrics = metrics
        self.logger = logger
        self.sample_interval_seconds = sample_interval_seconds
        self._s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        del tool_name, arguments
        self.metrics.sleep_started_at = datetime.now(UTC).isoformat()
        self.logger.info("sleep_start seconds=%s", self.sleep_seconds)
        deadline = time.monotonic() + self.sleep_seconds
        while time.monotonic() < deadline:
            self.metrics.turn_snapshots.append(
                turn_snapshot(self.plane, self.tenant_id, self.turn_id)
            )
            self.logger.info(
                "turn_sample status=%s claimed_by=%s recovery=%s",
                self.metrics.turn_snapshots[-1]["status"],
                self.metrics.turn_snapshots[-1]["claimed_by_worker_id"],
                self.metrics.turn_snapshots[-1]["recovery_attempts"],
            )
            remaining = deadline - time.monotonic()
            time.sleep(min(self.sample_interval_seconds, max(0.0, remaining)))
        self.metrics.sleep_finished_at = datetime.now(UTC).isoformat()
        self.logger.info("sleep_done")
        key = f"{S3_PREFIX}/{self.run_id}/artifact.bin"
        self.metrics.upload_started_at = datetime.now(UTC).isoformat()
        self.metrics.upload_result = put_sparse_object(
            self._s3,
            key=key,
            size_bytes=self.upload_bytes,
            logger=self.logger,
        )
        self.metrics.upload_finished_at = datetime.now(UTC).isoformat()
        self.logger.info("upload_done key=%s", key)
        return f"spike-complete s3://{S3_BUCKET}/{key}"


class InjectedSqsMessage:
    """Deliver one spike job body through the production receive_message path."""

    def __init__(self, body: str, *, receipt_handle: str = "spike-receipt-1") -> None:
        self._body = body
        self._receipt = receipt_handle
        self.deleted: str | None = None
        self.receive_count = 0

    def receive_message(self, **_kwargs: object) -> dict[str, object]:
        self.receive_count += 1
        if self.receive_count > 1:
            return {}
        return {
            "Messages": [
                {"Body": self._body, "ReceiptHandle": self._receipt},
            ]
        }

    def delete_message(self, **kwargs: object) -> None:
        self.deleted = str(kwargs.get("ReceiptHandle"))


class EmptySqs:
    """Mirror the host worker idle path when no queue message is available."""

    def receive_message(self, **_kwargs: object) -> dict[str, object]:
        return {}

    def delete_message(self, **_kwargs: object) -> None:
        return None


def require_env(*names: str) -> None:
    missing = [name for name in names if not os.environ.get(name, "").strip()]
    if missing:
        raise KeyError(f"Missing environment variables: {', '.join(missing)}")


def load_invoke_key() -> str:
    direct = os.environ.get("CHATTICUS_INVOKE_KEY", "").strip()
    if direct:
        return direct
    arn = os.environ.get("CHATTICUS_INVOKE_KEY_SECRET_ARN", "").strip()
    if not arn:
        raise KeyError("Set CHATTICUS_INVOKE_KEY or CHATTICUS_INVOKE_KEY_SECRET_ARN")
    client = boto3.client("secretsmanager", region_name="us-east-1")
    return client.get_secret_value(SecretId=arn)["SecretString"]
