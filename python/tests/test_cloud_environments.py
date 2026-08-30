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
        base_url="https://explicit.cloudfront.net/",
    )
    assert url == "https://explicit.cloudfront.net"


def test_resolve_reads_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "CHATTICUS_DEVELOPMENT_BASE_URL",
        "https://dev.cloudfront.net/",
    )
    url = resolve_thin_turn_base_url("development")
    assert url == "https://dev.cloudfront.net"


def test_ssm_auth_errors_are_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
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
            return {"Parameter": {"Value": "https://staging.cloudfront.net/"}}

    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: FakeSsm())
    url = resolve_thin_turn_base_url("staging")
    assert url == "https://staging.cloudfront.net"


def test_cloudformation_errors_become_lookup_errors(
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
    with pytest.raises(LookupError, match="ChatticusThinTurnProduction"):
        resolve_thin_turn_base_url("production")
