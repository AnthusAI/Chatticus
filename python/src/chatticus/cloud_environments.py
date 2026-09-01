"""Named Chatticus cloud environments and how to reach a thin-turn front door."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Literal

from chatticus.cognito_jwt import CognitoConfig

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


def web_parameter_prefix(environment: CloudEnvironment) -> str:
    """SSM prefix published by the web/auth stacks for this environment."""
    return f"/chatticus/{environment}/web"


def resolve_cognito_config(
    environment: CloudEnvironment,
    *,
    region: str = "us-east-1",
) -> CognitoConfig:
    """Resolve Cognito issuer and SPA client id for JWT verification.

    Order: ``CHATTICUS_COGNITO_*`` env vars, then SSM parameters under
    ``/chatticus/{environment}/web/cognito-*``.
    """
    issuer = os.environ.get("CHATTICUS_COGNITO_ISSUER", "").strip().rstrip("/")
    client_id = os.environ.get("CHATTICUS_COGNITO_CLIENT_ID", "").strip()
    jwks_url = os.environ.get("CHATTICUS_COGNITO_JWKS_URL", "").strip()
    if issuer and client_id:
        return CognitoConfig(
            issuer=issuer,
            client_id=client_id,
            jwks_url=jwks_url or f"{issuer}/.well-known/jwks.json",
        )

    try:
        import boto3
    except ImportError as exc:
        raise LookupError(
            "No Cognito config. Set CHATTICUS_COGNITO_ISSUER and "
            "CHATTICUS_COGNITO_CLIENT_ID, or install boto3 to read SSM."
        ) from exc

    prefix = web_parameter_prefix(environment)
    ssm = boto3.client("ssm", region_name=region)
    pool_id = _ssm_string_parameter(ssm, f"{prefix}/cognito-user-pool-id")
    resolved_client_id = _ssm_string_parameter(ssm, f"{prefix}/cognito-app-client-id")
    resolved_issuer = f"https://cognito-idp.{region}.amazonaws.com/{pool_id}"
    return CognitoConfig(
        issuer=resolved_issuer,
        client_id=resolved_client_id,
        jwks_url=f"{resolved_issuer}/.well-known/jwks.json",
    )


def _ssm_string_parameter(ssm: object, name: str) -> str:
    try:
        response = ssm.get_parameter(Name=name)  # type: ignore[union-attr]
    except Exception as error:
        raise LookupError(
            f"SSM parameter {name!r} is missing or unreadable."
        ) from error
    value = response["Parameter"]["Value"].strip()
    if not value:
        raise LookupError(f"SSM parameter {name!r} is empty.")
    return value


def base_url_environment_variable(environment: CloudEnvironment) -> str:
    """Process environment variable that may hold the CloudFront origin."""
    return f"CHATTICUS_{environment.upper()}_BASE_URL"


def resolve_thin_turn_base_url(
    environment: CloudEnvironment,
    *,
    base_url: str | None = None,
    region: str = "us-east-1",
) -> str:
    """Resolve the thin-turn API base URL for a named environment.

    Order: explicit URL, process environment, SSM, CloudFormation output.
    When AWS lookup fails, set ``CHATTICUS_{ENV}_BASE_URL`` or pass
    ``--base-url`` (see repo-root ``AGENTS.local.md``).
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
    try:
        stack = cloudformation.describe_stacks(StackName=stack_name)
    except Exception as error:
        raise LookupError(
            f"Could not read CloudFormation stack {stack_name} for "
            f"{environment}. Set {base_url_environment_variable(environment)} "
            "or deploy that environment."
        ) from error
    outputs = {
        output["OutputKey"]: output["OutputValue"]
        for output in stack["Stacks"][0].get("Outputs", [])
    }
    resolved = outputs.get("CloudFrontUrl") or outputs.get("FunctionUrl")
    if not resolved:
        raise LookupError(
            f"Stack {stack_name} has no CloudFrontUrl or FunctionUrl output. "
            f"Set {base_url_environment_variable(environment)} or deploy "
            f"{environment}."
        )
    return resolved.rstrip("/")


def thin_turn_stack_output(
    environment: CloudEnvironment,
    output_key: str,
    *,
    region: str = "us-east-1",
) -> str:
    """Return one CloudFormation output from the named thin-turn stack."""
    import boto3

    stack_name = THIN_TURN_STACK_IDS[environment]
    cloudformation = boto3.client("cloudformation", region_name=region)
    stack = cloudformation.describe_stacks(StackName=stack_name)
    outputs = {
        output["OutputKey"]: output["OutputValue"]
        for output in stack["Stacks"][0].get("Outputs", [])
    }
    value = outputs.get(output_key)
    if not value:
        raise LookupError(
            f"Stack {stack_name} has no {output_key} output. "
            f"Deploy that environment before accepting against {environment}."
        )
    return value


def resolve_invoke_key_for_environment(
    environment: CloudEnvironment,
    *,
    invoke_key: str | None = None,
    region: str | None = None,
) -> str:
    """Return the thin-turn front-door invoke key for a named environment.

    Order: explicit value, ``CHATTICUS_INVOKE_KEY``, Secrets Manager
    ``InvokeKeySecretArn`` from the thin-turn stack.
    """
    explicit = (invoke_key or os.environ.get("CHATTICUS_INVOKE_KEY", "")).strip()
    if explicit:
        return explicit
    resolved_region = (
        region
        or os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    arn = thin_turn_stack_output(
        environment, "InvokeKeySecretArn", region=resolved_region
    )
    import boto3

    secret = boto3.client(
        "secretsmanager", region_name=resolved_region
    ).get_secret_value(SecretId=arn)
    return secret["SecretString"]
