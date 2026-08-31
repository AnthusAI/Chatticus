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
