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
    assert "ChatticusComputers" not in text
    assert "ChatticusSnapshots" not in text
    assert "aws sts get-caller-identity" in text
