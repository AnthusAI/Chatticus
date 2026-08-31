"""Kernel tests for the host-start driver protocol."""

from __future__ import annotations

from chatticus.computer_start import HostStartClaim
from chatticus.host_starter import (
    EcsHostStarter,
    NoOpHostStarter,
    RecordingHostStarter,
    host_starter_from_env,
)


def test_noop_host_starter_accepts_claims() -> None:
    claim = HostStartClaim(
        tenant_id="anthus",
        computer_id="household-computer",
        host_start_count=1,
    )
    NoOpHostStarter().start_host(claim)


def test_recording_host_starter_captures_claims() -> None:
    starter = RecordingHostStarter()
    claim = HostStartClaim(
        tenant_id="anthus",
        computer_id="household-computer",
        host_start_count=2,
        waiting_turn_ids=["turn-1"],
    )
    starter.start_host(claim)
    assert starter.invocations == [claim]


def test_ecs_host_starter_skips_without_configuration() -> None:
    class FakeEcs:
        def __init__(self) -> None:
            self.calls = 0

        def run_task(self, **_kwargs: object) -> None:
            self.calls += 1

    ecs = FakeEcs()
    EcsHostStarter(
        ecs_client=ecs, cluster="", task_definition="", subnets=[]
    ).start_host(
        HostStartClaim(
            tenant_id="anthus",
            computer_id="household-computer",
            host_start_count=1,
        )
    )
    assert ecs.calls == 0


def test_ecs_host_starter_runs_task_when_configured() -> None:
    class FakeEcs:
        def __init__(self) -> None:
            self.kwargs: dict[str, object] | None = None

        def run_task(self, **kwargs: object) -> None:
            self.kwargs = kwargs

    ecs = FakeEcs()
    claim = HostStartClaim(
        tenant_id="anthus",
        computer_id="household-computer",
        host_start_count=3,
    )
    EcsHostStarter(
        ecs_client=ecs,
        cluster="ChatticusComputers",
        task_definition="computer",
        subnets=["subnet-1"],
        security_groups=["sg-1"],
    ).start_host(claim)
    assert ecs.kwargs is not None
    assert ecs.kwargs["cluster"] == "ChatticusComputers"
    assert ecs.kwargs["taskDefinition"] == "computer"
    assert ecs.kwargs["tags"] == [
        {"key": "tenant_id", "value": "anthus"},
        {"key": "computer_id", "value": "household-computer"},
        {"key": "host_start_generation", "value": "3"},
    ]
    assert "overrides" not in ecs.kwargs


def test_ecs_host_starter_overrides_host_worker_command(monkeypatch: object) -> None:
    monkeypatch.setenv(  # type: ignore[attr-defined]
        "CHATTICUS_ECS_HOST_COMMAND", "python -m chatticus.computer_host_worker"
    )
    monkeypatch.setenv("CHATTICUS_ECS_CONTAINER_NAME", "computer")  # type: ignore[attr-defined]
    monkeypatch.setenv(  # type: ignore[attr-defined]
        "CHATTICUS_COMPUTER_TURN_QUEUE_URL", "https://sqs.example/computer"
    )

    class FakeEcs:
        def __init__(self) -> None:
            self.kwargs: dict[str, object] | None = None

        def run_task(self, **kwargs: object) -> None:
            self.kwargs = kwargs

    ecs = FakeEcs()
    EcsHostStarter(
        ecs_client=ecs,
        cluster="ChatticusComputers",
        task_definition="computer",
        subnets=["subnet-1"],
        security_groups=["sg-1"],
    ).start_host(
        HostStartClaim(
            tenant_id="anthus",
            computer_id="household-computer",
            host_start_count=1,
            user_id="ryan",
        )
    )
    assert ecs.kwargs is not None
    container = ecs.kwargs["overrides"]["containerOverrides"][0]  # type: ignore[index]
    assert container["command"] == ["python", "-m", "chatticus.computer_host_worker"]
    names = {item["name"] for item in container["environment"]}
    assert "CHATTICUS_TENANT_ID" in names
    assert "CHATTICUS_COMPUTER_TURN_QUEUE_URL" in names


def test_host_starter_from_env_defaults_to_noop(monkeypatch: object) -> None:
    monkeypatch.delenv("CHATTICUS_HOST_STARTER", raising=False)  # type: ignore[attr-defined]
    assert isinstance(host_starter_from_env(), NoOpHostStarter)


def test_host_starter_from_env_selects_ecs(monkeypatch: object) -> None:
    monkeypatch.setenv("CHATTICUS_HOST_STARTER", "ecs")  # type: ignore[attr-defined]
    assert isinstance(host_starter_from_env(), EcsHostStarter)
