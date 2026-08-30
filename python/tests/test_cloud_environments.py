"""Named cloud environments used for promotion and acceptance."""

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
