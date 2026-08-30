"""Named Chatticus cloud environments and how to reach a thin-turn front door."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Literal

CloudEnvironment = Literal["development", "staging", "production"]

CLOUD_ENVIRONMENTS: tuple[CloudEnvironment, ...] = (
    "development",
    "staging",
    "production",
)

THIN_TURN_STACK_IDS: Mapping[CloudEnvironment, str] = {
    "development": "ChatticusThinTurn",
    "staging": "ChatticusThinTurnStaging",
    "production": "ChatticusThinTurnProduction",
}

GIT_BRANCH_CLOUD_ENVIRONMENT: Mapping[str, CloudEnvironment] = {
    "develop": "development",
    "main": "staging",
}


def parse_cloud_environment(value: str) -> CloudEnvironment:
    """Return a named environment or raise ValueError."""
    if value in CLOUD_ENVIRONMENTS:
        return value  # type: ignore[return-value]
    names = ", ".join(CLOUD_ENVIRONMENTS)
    raise ValueError(f"Unknown cloud environment {value!r}; expected one of: {names}")


def environment_for_git_branch(branch: str) -> CloudEnvironment:
    """Map an integration or release branch to the environment it updates.

    Production is never implied by a git branch. It is an explicit deploy of
    a release that already passed staging acceptance.
    """
    try:
        return GIT_BRANCH_CLOUD_ENVIRONMENT[branch]
    except KeyError as exc:
        raise ValueError(
            f"Branch {branch!r} does not map to a cloud environment. "
            "Feature work merges to develop (development). Promote to main "
            "for staging. Production is a gated deploy."
        ) from exc


def thin_turn_parameter_prefix(environment: CloudEnvironment) -> str:
    """SSM prefix published by the thin-turn stack for this environment."""
    return f"/chatticus/{environment}/thin-turn"


def base_url_environment_variable(environment: CloudEnvironment) -> str:
    """Process environment variable that may hold the CloudFront origin."""
    return f"CHATTICUS_{environment.upper()}_BASE_URL"


def resolve_thin_turn_base_url(
    environment: CloudEnvironment,
    *,
    base_url: str | None = None,
    region: str = "us-east-1",
) -> str:
    """Resolve the CloudFront origin for a named environment.

    Order: explicit URL, process environment, SSM, CloudFormation output.
    """
    if base_url:
        return base_url.rstrip("/")
    from_env = os.environ.get(base_url_environment_variable(environment))
    if from_env:
        return from_env.rstrip("/")
    parameter_name = f"{thin_turn_parameter_prefix(environment)}/cloudfront-url"
    try:
        import boto3
    except ImportError as exc:
        raise LookupError(
            f"No base URL for {environment}. Set "
            f"{base_url_environment_variable(environment)}, pass --base-url, "
            "or install boto3 to read SSM / CloudFormation."
        ) from exc
    ssm = boto3.client("ssm", region_name=region)
    try:
        response = ssm.get_parameter(Name=parameter_name)
    except ssm.exceptions.ParameterNotFound:
        response = None
    if response is not None:
        value = response["Parameter"]["Value"].rstrip("/")
        if value:
            return value
    stack_name = THIN_TURN_STACK_IDS[environment]
    cloudformation = boto3.client("cloudformation", region_name=region)
    stack = cloudformation.describe_stacks(StackName=stack_name)
    outputs = {
        output["OutputKey"]: output["OutputValue"]
        for output in stack["Stacks"][0].get("Outputs", [])
    }
    cloudfront_url = outputs.get("CloudFrontUrl")
    if not cloudfront_url:
        raise LookupError(
            f"Stack {stack_name} has no CloudFrontUrl output. "
            f"Deploy that environment before accepting against {environment}."
        )
    return cloudfront_url.rstrip("/")
