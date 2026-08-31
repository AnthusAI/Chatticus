"""Named cloud environments used for promotion and acceptance."""

from pathlib import Path

import pytest

from chatticus.cloud_environments import (
    CLOUD_ENVIRONMENTS,
    GIT_BRANCH_CLOUD_ENVIRONMENT,
    THIN_TURN_STACK_IDS,
    environment_for_git_branch,
    parse_cloud_environment,
    resolve_thin_turn_base_url,
    thin_turn_parameter_prefix,
)


def test_three_named_environments() -> None:
    assert CLOUD_ENVIRONMENTS == ("development", "staging", "production")
    assert THIN_TURN_STACK_IDS["development"] == "ChatticusThinTurn"
    assert THIN_TURN_STACK_IDS["staging"] == "ChatticusThinTurnStaging"
    assert THIN_TURN_STACK_IDS["production"] == "ChatticusThinTurnProduction"


def test_git_branches_do_not_imply_production() -> None:
    assert environment_for_git_branch("develop") == "development"
    assert environment_for_git_branch("main") == "staging"
    assert "production" not in GIT_BRANCH_CLOUD_ENVIRONMENT.values()


def test_parse_rejects_nameless_stacks() -> None:
    assert parse_cloud_environment("staging") == "staging"
    try:
        parse_cloud_environment("lab")
    except ValueError as error:
        assert "development" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_ssm_prefix_is_per_environment() -> None:
    assert thin_turn_parameter_prefix("development") == (
        "/chatticus/development/thin-turn"
    )
    assert thin_turn_parameter_prefix("production") == (
        "/chatticus/production/thin-turn"
    )


def test_resolve_prefers_explicit_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "CHATTICUS_STAGING_BASE_URL",
        "https://from-env.example",
    )
    url = resolve_thin_turn_base_url(
        "staging",
        base_url="https://explicit.example/",
    )
    assert url == "https://explicit.example"


def test_resolve_reads_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "CHATTICUS_DEVELOPMENT_BASE_URL",
        "https://dev.example/api",
    )
    url = resolve_thin_turn_base_url("development")
    assert url == "https://dev.example/api"


def test_ssm_auth_errors_require_env_or_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CHATTICUS_DEVELOPMENT_BASE_URL", raising=False)
    import boto3

    class FakeSsm:
        class exceptions:
            class ParameterNotFound(Exception):
                pass

        def get_parameter(self, Name: str) -> dict:
            raise RuntimeError("LoginRefreshRequired")

    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: FakeSsm())
    with pytest.raises(RuntimeError, match="LoginRefreshRequired"):
        resolve_thin_turn_base_url("development")


def test_unknown_git_branch_does_not_map() -> None:
    with pytest.raises(ValueError, match="cursor/feature"):
        environment_for_git_branch("cursor/feature")


def test_python_stack_ids_match_cdk() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "infra" / "lib" / "environments.ts"
    ).read_text()
    for environment, stack_id in THIN_TURN_STACK_IDS.items():
        assert f'{environment}: "{stack_id}"' in source


def test_resolve_uses_ssm_parameter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CHATTICUS_STAGING_BASE_URL", raising=False)
    import boto3

    class FakeSsm:
        class exceptions:
            class ParameterNotFound(Exception):
                pass

        def get_parameter(self, Name: str) -> dict:
            assert Name == "/chatticus/staging/thin-turn/cloudfront-url"
            return {"Parameter": {"Value": "https://staging.example/api"}}

    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: FakeSsm())
    url = resolve_thin_turn_base_url("staging")
    assert url == "https://staging.example/api"


def test_cloudformation_auth_errors_require_env_or_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CHATTICUS_PRODUCTION_BASE_URL", raising=False)
    import boto3

    class FakeSsm:
        class exceptions:
            class ParameterNotFound(Exception):
                pass

        def get_parameter(self, Name: str) -> dict:
            raise FakeSsm.exceptions.ParameterNotFound()

    class FakeCloudFormation:
        def describe_stacks(self, StackName: str) -> dict:
            raise RuntimeError("ExpiredToken")

    def client(name: str, region_name: str | None = None) -> object:
        if name == "ssm":
            return FakeSsm()
        if name == "cloudformation":
            return FakeCloudFormation()
        raise AssertionError(name)

    monkeypatch.setattr(boto3, "client", client)
    with pytest.raises(LookupError, match="Could not read CloudFormation"):
        resolve_thin_turn_base_url("production")


def test_thin_turn_stack_output_reads_cloudformation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import boto3

    class FakeCloudFormation:
        def describe_stacks(self, StackName: str) -> dict:
            assert StackName == "ChatticusThinTurn"
            return {
                "Stacks": [
                    {
                        "Outputs": [
                            {
                                "OutputKey": "ComputerTurnQueueUrl",
                                "OutputValue": "https://sqs.example/computer",
                            }
                        ]
                    }
                ]
            }

    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: FakeCloudFormation())
    from chatticus.cloud_environments import thin_turn_stack_output

    url = thin_turn_stack_output("development", "ComputerTurnQueueUrl")
    assert url == "https://sqs.example/computer"


def test_resolve_uses_function_url_when_cloudfront_output_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CHATTICUS_DEVELOPMENT_BASE_URL", raising=False)
    import boto3

    class FakeSsm:
        class exceptions:
            class ParameterNotFound(Exception):
                pass

        def get_parameter(self, Name: str) -> dict:
            raise FakeSsm.exceptions.ParameterNotFound()

    class FakeCloudFormation:
        def describe_stacks(self, StackName: str) -> dict:
            assert StackName == "ChatticusThinTurn"
            return {
                "Stacks": [
                    {
                        "Outputs": [
                            {
                                "OutputKey": "FunctionUrl",
                                "OutputValue": "https://example.lambda-url.us-east-1.on.aws/",
                            }
                        ]
                    }
                ]
            }

    def client(name: str, region_name: str | None = None) -> object:
        if name == "ssm":
            return FakeSsm()
        if name == "cloudformation":
            return FakeCloudFormation()
        raise AssertionError(name)

    monkeypatch.setattr(boto3, "client", client)
    url = resolve_thin_turn_base_url("development")
    assert url == "https://example.lambda-url.us-east-1.on.aws"


def test_committed_tree_does_not_embed_account_origins() -> None:
    """Account CloudFront hosts and account ids stay in AGENTS.local.md."""
    root = Path(__file__).resolve().parents[2]
    forbidden = (
        "335163751677",
        "d3gpuuldffe35o",
        "dntj3flm2ozck",
        "d3lnmalpqx92ls",
        "d3gds8al0gg3jl",
        "d1jcaavght8v16",
        "wwfo67h32ahlhyaxs23p4rraba0fgxit",
        "6r537llsebh3kvok37t4vsvldu0mwpdf",
        "AdministratorAccess-335163751677",
    )
    skip_prefixes = (
        "project/issues/",
        "project/events/",
    )
    skip_files = {
        "infra/cdk.context.json",  # CDK AZ lookup cache for CI synth
        "python/tests/test_cloud_environments.py",
    }
    import subprocess

    tracked = subprocess.check_output(
        ["git", "ls-files"],
        cwd=root,
        text=True,
    ).splitlines()
    hits: list[str] = []
    for rel in tracked:
        if rel in skip_files or rel.startswith(skip_prefixes):
            continue
        path = root / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError, IsADirectoryError):
            continue
        for token in forbidden:
            if token in text:
                hits.append(f"{rel}: {token}")
    assert hits == []
