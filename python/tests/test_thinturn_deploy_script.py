"""The development ThinTurn deploy helper must not widen to --all."""

from pathlib import Path


def test_development_thinturn_deploy_script_is_one_stack() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy-chatticus-thinturn-development.sh"
    )
    text = script.read_text()
    assert "cdk deploy ChatticusThinTurn --require-approval never" in text
    assert "deploy --all" not in text
    assert "ChatticusThinTurnStaging" not in text
    assert "cdk deploy ChatticusComputers" not in text
    assert "cdk deploy ChatticusSnapshots" not in text
    assert "aws sts get-caller-identity" in text


def test_computer_worker_ecs_host_start_may_tag_tasks() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "infra" / "lib" / "computer-host-start.ts"
    )
    text = source.read_text()
    assert "ecs:TagResource" in text
    assert "ecs:RunTask" in text
    assert "grantConsumeMessages" in text
    assert "ImportedComputerHostTaskRole" in text
    assert "computerHostCommand" in text
    assert "CHATTICUS_ECS_HOST_COMMAND" in text
    assert "python -m chatticus.computer_host_worker" in text


def test_development_thinturn_deploy_script_does_not_enable_host_command() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy-chatticus-thinturn-development.sh"
    )
    text = script.read_text()
    assert "computerHostCommand" not in text
    assert "CHATTICUS_ECS_HOST_COMMAND" not in text


def test_development_thinturn_deploy_script_reads_computer_stack_outputs() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy-chatticus-thinturn-development.sh"
    )
    text = script.read_text()
    assert "ComputerClusterName" in text
    assert "computerHostStart=ecs" in text
    assert "describe-task-definition" in text


def test_cdk_app_uses_tsx_not_ts_node() -> None:
    cdk_json = Path(__file__).resolve().parents[2] / "infra" / "cdk.json"
    text = cdk_json.read_text()
    assert "tsx bin/chatticus.ts" in text
    assert "ts-node" not in text
