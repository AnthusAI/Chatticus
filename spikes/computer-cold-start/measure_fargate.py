"""Throwaway Test 2 measurement: cold Fargate ARM64 computer image gates.

Does not live in python/src. Does not change the Computers stack. Stops
each task after the smoke snapshot appears and leaves desired count at 0.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
CLUSTER = "ChatticusComputers-ClusterEB0386A7-KBVRNWeg2bzf"
TASK_DEFINITION = "ChatticusComputersComputerTask96CD9924:5"
SUBNETS = ["subnet-0b7f7c7be05091111", "subnet-06c4e78bf06400f26"]
SECURITY_GROUPS = ["sg-0b02b09326fa45366"]
BUCKET = "chatticussnapshots-computersnapshotsb892d73f-r8qgykc9zjiq"
TENANT = "anthus"
LOG_GROUP = "ChatticusComputers-ComputerLogs3CD929E4-28QzCbANHYCu"
RUNS = 5
RUNNING_TIMEOUT_S = 480
MANIFEST_TIMEOUT_S = 480
STOP_TIMEOUT_S = 180


def _now() -> float:
    return time.monotonic()


def _iso() -> str:
    return datetime.now(UTC).isoformat()


def _manifest_key(computer: str) -> str:
    return f"tenants/{TENANT}/computers/{computer}/manifest.json"


def _wait_running(ecs, task_arn: str, deadline: float) -> tuple[float | None, dict]:
    while _now() < deadline:
        described = ecs.describe_tasks(cluster=CLUSTER, tasks=[task_arn])
        task = (described.get("tasks") or [{}])[0]
        status = task.get("lastStatus")
        if status == "RUNNING":
            return _now(), task
        if status in {"STOPPED", "DEPROVISIONING"}:
            return None, task
        time.sleep(2)
    described = ecs.describe_tasks(cluster=CLUSTER, tasks=[task_arn])
    return None, (described.get("tasks") or [{}])[0]


def _wait_manifest(s3, computer: str, deadline: float) -> float | None:
    while _now() < deadline:
        try:
            s3.head_object(Bucket=BUCKET, Key=_manifest_key(computer))
            return _now()
        except ClientError:
            time.sleep(2)
    return None


def _first_log_age_s(logs, task_id: str) -> float | None:
    stream = f"computer/computer/{task_id}"
    deadline = _now() + 60
    while _now() < deadline:
        try:
            events = logs.get_log_events(
                logGroupName=LOG_GROUP,
                logStreamName=stream,
                startFromHead=True,
                limit=10,
            )
        except logs.exceptions.ResourceNotFoundException:
            time.sleep(2)
            continue
        found = events.get("events") or []
        if found:
            return found[0]["timestamp"] / 1000.0
        time.sleep(2)
    return None


def _stop(ecs, task_arn: str) -> None:
    ecs.stop_task(cluster=CLUSTER, task=task_arn, reason="cold-start measurement")
    deadline = _now() + STOP_TIMEOUT_S
    while _now() < deadline:
        described = ecs.describe_tasks(cluster=CLUSTER, tasks=[task_arn])
        task = (described.get("tasks") or [{}])[0]
        if task.get("lastStatus") == "STOPPED":
            return
        time.sleep(2)


def main() -> int:
    ecs = boto3.client("ecs", region_name=REGION)
    s3 = boto3.client("s3", region_name=REGION)
    logs = boto3.client("logs", region_name=REGION)
    results = []
    out_dir = Path(__file__).resolve().parent / "results"
    out_dir.mkdir(exist_ok=True)

    for index in range(1, RUNS + 1):
        computer = f"cold-start-{index}-{int(time.time())}"
        submitted = _now()
        wall_start = _iso()
        print(
            f"run {index}/{RUNS} submitted={wall_start} computer={computer}",
            flush=True,
        )
        response = ecs.run_task(
            cluster=CLUSTER,
            taskDefinition=TASK_DEFINITION,
            launchType="FARGATE",
            count=1,
            platformVersion="LATEST",
            networkConfiguration={
                "awsvpcConfiguration": {
                    "subnets": SUBNETS,
                    "securityGroups": SECURITY_GROUPS,
                    "assignPublicIp": "ENABLED",
                }
            },
            overrides={
                "containerOverrides": [
                    {
                        "name": "computer",
                        "environment": [
                            {"name": "CHATTICUS_SMOKE_COMPUTER", "value": computer},
                        ],
                    }
                ]
            },
        )
        failures = response.get("failures") or []
        tasks = response.get("tasks") or []
        if failures or not tasks:
            row = {
                "run": index,
                "error": failures or "no task",
                "wall_start": wall_start,
            }
            print(json.dumps(row), flush=True)
            results.append(row)
            continue
        task_arn = tasks[0]["taskArn"]
        task_id = task_arn.rsplit("/", 1)[-1]
        try:
            running_at, task = _wait_running(
                ecs, task_arn, submitted + RUNNING_TIMEOUT_S
            )
            t_running = None if running_at is None else running_at - submitted
            t_manifest = None
            if running_at is not None:
                manifest_at = _wait_manifest(
                    s3, computer, submitted + MANIFEST_TIMEOUT_S
                )
                if manifest_at is not None:
                    t_manifest = manifest_at - submitted
            first_log = _first_log_age_s(logs, task_id)
            wall_submitted = datetime.fromisoformat(wall_start).timestamp()
            t_first_log = None if first_log is None else first_log - wall_submitted
            row = {
                "run": index,
                "computer": computer,
                "task_id": task_id,
                "wall_start": wall_start,
                "seconds_to_running": t_running,
                "seconds_to_smoke_manifest": t_manifest,
                "seconds_to_first_log": t_first_log,
                "last_status": task.get("lastStatus"),
                "stop_code": task.get("stopCode"),
                "stopped_reason": task.get("stoppedReason"),
                "chromium": "not_in_image",
            }
            print(json.dumps(row), flush=True)
            results.append(row)
        finally:
            _stop(ecs, task_arn)

    (out_dir / "fargate.json").write_text(
        json.dumps(
            {
                "measured_at": _iso(),
                "task_definition": TASK_DEFINITION,
                "image": "chatticuscomputers-computerimage67d4263c-h3us7njdifay:dev",
                "image_pushed_at": "2026-08-30T04:46:03-04:00",
                "local_docker": "unavailable (docker daemon socket missing)",
                "chromium": "not in computer/Dockerfile; recorded incomplete",
                "runs": results,
            },
            indent=2,
        )
        + "\n"
    )
    print("wrote", out_dir / "fargate.json", flush=True)
    return 0 if all("error" not in row for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
