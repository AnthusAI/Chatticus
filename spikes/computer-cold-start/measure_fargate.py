"""Throwaway Test 2 measurement: cold summoned Fargate ARM64 browser gate.

Does not live in python/src. Does not change the Computers stack. Stops
each task after the browser gate marker appears and leaves desired count at 0.
"""

from __future__ import annotations

import json
import statistics
import time
from datetime import UTC, datetime
from pathlib import Path

import boto3

REGION = "us-east-1"
STACK = "ChatticusComputers"
CONTAINER = "computer"
RUNS = 5
RUNNING_TIMEOUT_S = 480
BROWSER_GATE_TIMEOUT_S = 480
STOP_TIMEOUT_S = 180
BROWSER_GATE_PREFIX = "browser_gate_ready:"
BOOT_COMMAND = [
    "python",
    "-c",
    (
        "from chatticus.computer_host_boot import ComputerHostBootDriver; "
        "r = ComputerHostBootDriver().boot_through_browser(); "
        "print(f'browser_gate_ready: {r.chromium_version}', flush=True)"
    ),
]


def _now() -> float:
    return time.monotonic()


def _iso() -> str:
    return datetime.now(UTC).isoformat()


def _stack_outputs(cfn) -> dict[str, str]:
    response = cfn.describe_stacks(StackName=STACK)
    outputs: dict[str, str] = {}
    for item in response["Stacks"][0].get("Outputs") or []:
        key = item.get("OutputKey")
        value = item.get("OutputValue")
        if key and value:
            outputs[key] = value
    return outputs


def _service_network(ecs, cluster: str, service: str) -> tuple[list[str], list[str]]:
    described = ecs.describe_services(cluster=cluster, services=[service])
    services = described.get("services") or []
    if not services:
        msg = f"ECS service {service!r} was not found on cluster {cluster!r}."
        raise RuntimeError(msg)
    network = services[0].get("networkConfiguration", {}).get(
        "awsvpcConfiguration", {}
    )
    subnets = list(network.get("subnets") or [])
    security_groups = list(network.get("securityGroups") or [])
    if not subnets or not security_groups:
        msg = "ECS service network configuration is missing subnets or security groups."
        raise RuntimeError(msg)
    return subnets, security_groups


def _task_log_group(ecs, task_definition: str) -> str:
    described = ecs.describe_task_definition(taskDefinition=task_definition)
    containers = described["taskDefinition"].get("containerDefinitions") or []
    for container in containers:
        if container.get("name") != CONTAINER:
            continue
        options = (container.get("logConfiguration") or {}).get("options") or {}
        log_group = options.get("awslogs-group", "").strip()
        if log_group:
            return log_group
    msg = f"Container {CONTAINER!r} has no awslogs-group in {task_definition!r}."
    raise RuntimeError(msg)


def _task_image(ecs, task_definition: str) -> str:
    described = ecs.describe_task_definition(taskDefinition=task_definition)
    containers = described["taskDefinition"].get("containerDefinitions") or []
    for container in containers:
        if container.get("name") == CONTAINER:
            return str(container.get("image") or "")
    return ""


def _assert_desired_count_zero(ecs, cluster: str, service: str) -> int:
    described = ecs.describe_services(cluster=cluster, services=[service])
    services = described.get("services") or []
    if not services:
        msg = f"ECS service {service!r} was not found on cluster {cluster!r}."
        raise RuntimeError(msg)
    desired = int(services[0].get("desiredCount") or 0)
    if desired != 0:
        msg = (
            f"Refusing to measure: {service!r} desiredCount={desired}, expected 0."
        )
        raise RuntimeError(msg)
    return desired


def _stop_leftover_tasks(ecs, cluster: str) -> list[str]:
    stopped: list[str] = []
    paginator = ecs.get_paginator("list_tasks")
    for page in paginator.paginate(cluster=cluster, desiredStatus="RUNNING"):
        for task_arn in page.get("taskArns") or []:
            ecs.stop_task(
                cluster=cluster,
                task=task_arn,
                reason="chatticus-d68966 preflight cleanup",
            )
            stopped.append(task_arn)
    return stopped


def _wait_running(
    ecs, cluster: str, task_arn: str, deadline: float
) -> tuple[float | None, dict]:
    while _now() < deadline:
        described = ecs.describe_tasks(cluster=cluster, tasks=[task_arn])
        task = (described.get("tasks") or [{}])[0]
        status = task.get("lastStatus")
        if status == "RUNNING":
            return _now(), task
        if status in {"STOPPED", "DEPROVISIONING"}:
            return None, task
        time.sleep(2)
    described = ecs.describe_tasks(cluster=cluster, tasks=[task_arn])
    return None, (described.get("tasks") or [{}])[0]


def _wait_browser_gate(
    logs, log_group: str, task_id: str, deadline: float
) -> tuple[float | None, str | None]:
    stream = f"computer/{CONTAINER}/{task_id}"
    while _now() < deadline:
        try:
            events = logs.get_log_events(
                logGroupName=log_group,
                logStreamName=stream,
                startFromHead=True,
                limit=100,
            )
        except logs.exceptions.ResourceNotFoundException:
            time.sleep(2)
            continue
        for event in events.get("events") or []:
            message = str(event.get("message") or "")
            if message.startswith(BROWSER_GATE_PREFIX):
                version = message[len(BROWSER_GATE_PREFIX) :].strip()
                return event["timestamp"] / 1000.0, version
        time.sleep(2)
    return None, None


def _stop(ecs, cluster: str, task_arn: str) -> None:
    ecs.stop_task(
        cluster=cluster, task=task_arn, reason="cold-start measurement"
    )
    deadline = _now() + STOP_TIMEOUT_S
    while _now() < deadline:
        described = ecs.describe_tasks(cluster=cluster, tasks=[task_arn])
        task = (described.get("tasks") or [{}])[0]
        if task.get("lastStatus") == "STOPPED":
            return
        time.sleep(2)


def _distribution(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "min": ordered[0],
        "median": statistics.median(ordered),
        "max": ordered[-1],
    }


def _task_definition_label(task_definition: str) -> str:
    """Return a revision label safe to commit (no account id in the ARN)."""
    if "/" in task_definition:
        return task_definition.rsplit("/", 1)[-1]
    return task_definition


def _image_label(image: str) -> str:
    """Return repository:tag safe to commit (no ECR account host)."""
    if "/" in image:
        return image.rsplit("/", 1)[-1]
    return image


def main() -> int:
    cfn = boto3.client("cloudformation", region_name=REGION)
    ecs = boto3.client("ecs", region_name=REGION)
    logs = boto3.client("logs", region_name=REGION)
    ecr = boto3.client("ecr", region_name=REGION)

    outputs = _stack_outputs(cfn)
    cluster = outputs["ComputerClusterName"]
    service = outputs["ComputerServiceName"]
    task_definition = outputs["ComputerTaskDefinitionArn"]
    repository_uri = outputs["ComputerRepositoryUri"]
    subnets, security_groups = _service_network(ecs, cluster, service)
    log_group = _task_log_group(ecs, task_definition)
    image = _task_image(ecs, task_definition)

    desired_count = _assert_desired_count_zero(ecs, cluster, service)
    leftover = _stop_leftover_tasks(ecs, cluster)
    if leftover:
        print(f"stopped {len(leftover)} leftover RUNNING task(s)", flush=True)

    repo_name = repository_uri.rsplit("/", 1)[-1]
    image_meta = ecr.describe_images(
        repositoryName=repo_name, imageIds=[{"imageTag": "dev"}]
    )["imageDetails"][0]
    image_pushed_at = image_meta.get("imagePushedAt")
    if hasattr(image_pushed_at, "isoformat"):
        image_pushed_at = image_pushed_at.isoformat()

    results = []
    out_dir = Path(__file__).resolve().parent / "results"
    out_dir.mkdir(exist_ok=True)

    for index in range(1, RUNS + 1):
        submitted = _now()
        wall_start = _iso()
        print(f"run {index}/{RUNS} submitted={wall_start}", flush=True)
        response = ecs.run_task(
            cluster=cluster,
            taskDefinition=task_definition,
            launchType="FARGATE",
            count=1,
            platformVersion="LATEST",
            networkConfiguration={
                "awsvpcConfiguration": {
                    "subnets": subnets,
                    "securityGroups": security_groups,
                    "assignPublicIp": "ENABLED",
                }
            },
            overrides={
                "containerOverrides": [
                    {
                        "name": CONTAINER,
                        "command": BOOT_COMMAND,
                        "environment": [
                            {"name": "CHATTICUS_COMPUTER_BOOT", "value": "1"},
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
                ecs, cluster, task_arn, submitted + RUNNING_TIMEOUT_S
            )
            t_running = None if running_at is None else running_at - submitted
            gate_wall_s: float | None = None
            chromium_version: str | None = None
            t_browser_gate: float | None = None
            if running_at is not None:
                gate_wall_s, chromium_version = _wait_browser_gate(
                    logs,
                    log_group,
                    task_id,
                    submitted + BROWSER_GATE_TIMEOUT_S,
                )
                if gate_wall_s is not None:
                    wall_submitted = datetime.fromisoformat(wall_start).timestamp()
                    t_browser_gate = gate_wall_s - wall_submitted
            row = {
                "run": index,
                "task_id": task_id,
                "wall_start": wall_start,
                "seconds_to_running": t_running,
                "seconds_to_browser_gate": t_browser_gate,
                "chromium_version": chromium_version,
                "last_status": task.get("lastStatus"),
                "stop_code": task.get("stopCode"),
                "stopped_reason": task.get("stoppedReason"),
            }
            print(json.dumps(row), flush=True)
            results.append(row)
        finally:
            _stop(ecs, cluster, task_arn)

    running_values = [
        row["seconds_to_running"]
        for row in results
        if row.get("seconds_to_running") is not None
    ]
    browser_values = [
        row["seconds_to_browser_gate"]
        for row in results
        if row.get("seconds_to_browser_gate") is not None
    ]
    summary = {
        "measured_at": _iso(),
        "issue": "chatticus-d68966",
        "mode": "summoned_browser_gate",
        "cluster": cluster,
        "service": service,
        "desired_count_at_start": desired_count,
        "task_definition": _task_definition_label(task_definition),
        "image": _image_label(image),
        "image_pushed_at": image_pushed_at,
        "image_digest": image_meta.get("imageDigest"),
        "log_group": log_group,
        "e747d7_running_baseline_seconds": {
            "min": 17.7,
            "median": 22.0,
            "max": 38.5,
        },
        "running_seconds": _distribution(running_values) if running_values else None,
        "browser_gate_seconds": (
            _distribution(browser_values) if browser_values else None
        ),
        "runs": results,
    }
    (out_dir / "fargate.json").write_text(json.dumps(summary, indent=2) + "\n")
    print("wrote", out_dir / "fargate.json", flush=True)

    ok = all("error" not in row for row in results) and len(browser_values) == RUNS
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
