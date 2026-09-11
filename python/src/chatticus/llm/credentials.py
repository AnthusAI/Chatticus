"""Read deployment LLM credentials from the process environment."""

from __future__ import annotations

import os

from chatticus.llm.catalog import DeploymentCredentials
from chatticus.llm.local_env import load_local_env


def _ssm_parameter_value(parameter_name: str) -> str:
    """Return one decrypted SSM parameter, or empty when it is missing."""
    if not parameter_name:
        return ""
    import boto3
    from botocore.exceptions import ClientError

    try:
        response = boto3.client("ssm").get_parameter(
            Name=parameter_name,
            WithDecryption=True,
        )
    except ClientError:
        return ""
    return str(response["Parameter"]["Value"]).strip()


def _key_from_env_or_ssm(env_name: str, parameter_env_name: str) -> str:
    """Prefer an injected secret, then an SSM parameter name in the environment."""
    direct = os.environ.get(env_name, "").strip()
    if direct:
        return direct
    return _ssm_parameter_value(os.environ.get(parameter_env_name, "").strip())


def _bedrock_enabled_from_env() -> bool:
    """Return whether this process is configured to call Bedrock."""
    flag = os.environ.get("CHATTICUS_BEDROCK_ENABLED", "").strip().lower()
    return flag in {"1", "true", "yes", "on"}


def credentials_from_env() -> DeploymentCredentials:
    """Load vendor keys and the Bedrock IAM flag for this deployment."""
    load_local_env()
    return DeploymentCredentials(
        openai_api_key=_key_from_env_or_ssm(
            "OPENAI_API_KEY", "OPENAI_API_KEY_PARAMETER"
        ),
        anthropic_api_key=_key_from_env_or_ssm(
            "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_PARAMETER"
        ),
        google_api_key=_key_from_env_or_ssm(
            "GOOGLE_API_KEY", "GOOGLE_API_KEY_PARAMETER"
        ),
        bedrock_enabled=_bedrock_enabled_from_env(),
    )


def default_model_id_from_env() -> str | None:
    """Return ``CHATTICUS_DEFAULT_MODEL`` when set."""
    value = os.environ.get("CHATTICUS_DEFAULT_MODEL", "").strip()
    return value or None
