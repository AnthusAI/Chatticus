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


def test_development_web_deploy_script_is_bounded() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy-chatticus-web-development.sh"
    )
    text = script.read_text()
    assert "cdk deploy ChatticusWeb --require-approval never" in text
    assert "ChatticusWeb" in text
    assert "deploy --all" not in text
    assert "ChatticusWebStaging" not in text
    assert "ChatticusWebProduction" not in text
    assert "ChatticusThinTurnStaging" not in text
    assert "ChatticusThinTurnProduction" not in text
    assert "cdk destroy" not in text
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
    assert "lookupComputersHostStart" in text
    assert "ChatticusComputers" in text
    assert "computerHostStart=noop" in text


def test_development_thinturn_deploy_script_enables_host_command() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy-chatticus-thinturn-development.sh"
    )
    text = script.read_text()
    assert "computerHostCommand=host-worker" in text
    assert "cdk deploy ChatticusComputers" not in text


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


def test_computer_worker_lambda_forwards_front_door_url() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "infra" / "lib" / "thin-turn-stack.ts"
    )
    text = source.read_text()
    assert "CHATTICUS_FRONT_DOOR_URL: functionUrl.url" in text


def test_thin_turn_stack_uses_per_deployment_openai_parameter() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "infra" / "lib" / "thin-turn-stack.ts"
    )
    text = source.read_text()
    assert "/amplify/shared/papyrus/OPENAI_API_KEY" not in text
    assert "OPENAI_PARAMETER_NAME" not in text
    assert "${parameterPrefix}/openai-api-key" in text
    assert "openAiParameterName" in text
    assert "fromSecureStringParameterAttributes" in text
    assert "OPENAI_API_KEY_PARAMETER: openAiParameterName" in text
    for line in text.splitlines():
        if "openAiParameterName" in line:
            assert "unsafeUnwrap" not in line


def test_cdk_app_uses_tsx_not_ts_node() -> None:
    cdk_json = Path(__file__).resolve().parents[2] / "infra" / "cdk.json"
    text = cdk_json.read_text()
    assert "tsx bin/chatticus.ts" in text
    assert "ts-node" not in text


def test_github_deploy_stack_trusts_thinturn_development_workflow() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "infra" / "lib" / "github-deploy-stack.ts"
    )
    text = source.read_text()
    assert "ChatticusGitHubDeploy" not in text
    assert "chatticus-github-actions-deploy" in text
    assert "deploy-thinturn-development.yml" in text
    assert "deploy-web-development.yml" in text
    assert "token.actions.githubusercontent.com:environment" in text
    assert '"token.actions.githubusercontent.com:environment": "development"' in text
    assert "AdministratorAccess" in text
    assert "ChatticusThinTurnStaging" not in text
    assert "ChatticusThinTurnProduction" not in text
    assert "ChatticusWebStaging" not in text
    assert "ChatticusWebProduction" not in text
    assert "deploy --all" not in text
    assert "cdk deploy ChatticusComputers" not in text
    assert "cdk deploy ChatticusSnapshots" not in text
    assert 'environment": "staging"' not in text
    assert 'environment": "production"' not in text


def test_github_deploy_script_is_one_stack() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy-chatticus-github-deploy.sh"
    )
    text = script.read_text()
    assert "cdk deploy ChatticusGitHubDeploy --require-approval never" in text
    assert "deploy --all" not in text
    assert "ChatticusSnapshots" not in text
    assert "ChatticusComputers" not in text
