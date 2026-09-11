"""Deployment model catalog: interchangeable vendors, filtered by credentials."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.models import UnknownModelError
from chatticus.vendor_ledger import BILLED_VIA_AWS, BILLED_VIA_VENDOR

VENDOR_OPENAI = "openai"
VENDOR_BEDROCK = "bedrock"
VENDOR_ANTHROPIC = "anthropic"
VENDOR_GOOGLE = "google"

CREDENTIAL_OPENAI = "openai_api_key"
CREDENTIAL_BEDROCK = "bedrock_iam"
CREDENTIAL_ANTHROPIC = "anthropic_api_key"
CREDENTIAL_GOOGLE = "google_api_key"

OPENAI_GPT_56_LUNA_ID = "openai/gpt-5.6-luna"
BEDROCK_CLAUDE_SONNET_ID = "bedrock/anthropic.claude-sonnet-4-5"
BEDROCK_NOVA_LITE_ID = "bedrock/amazon.nova-lite-v1:0"
ANTHROPIC_CLAUDE_SONNET_ID = "anthropic/claude-sonnet-4-5"
GOOGLE_GEMINI_FLASH_ID = "google/gemini-2.5-flash"


@dataclass(frozen=True)
class ModelOption:
    """One selectable model this deployment may offer."""

    model_id: str
    vendor: str
    provider_model: str
    display_name: str
    billed_via: str
    credential: str


KNOWN_MODELS: tuple[ModelOption, ...] = (
    ModelOption(
        model_id=OPENAI_GPT_56_LUNA_ID,
        vendor=VENDOR_OPENAI,
        provider_model="gpt-5.6-luna",
        display_name="GPT-5.6 Luna",
        billed_via=BILLED_VIA_VENDOR,
        credential=CREDENTIAL_OPENAI,
    ),
    ModelOption(
        model_id=BEDROCK_CLAUDE_SONNET_ID,
        vendor=VENDOR_BEDROCK,
        provider_model="anthropic.claude-sonnet-4-5",
        display_name="Claude Sonnet 4.5 (Bedrock)",
        billed_via=BILLED_VIA_AWS,
        credential=CREDENTIAL_BEDROCK,
    ),
    ModelOption(
        model_id=BEDROCK_NOVA_LITE_ID,
        vendor=VENDOR_BEDROCK,
        provider_model="amazon.nova-lite-v1:0",
        display_name="Amazon Nova Lite",
        billed_via=BILLED_VIA_AWS,
        credential=CREDENTIAL_BEDROCK,
    ),
    ModelOption(
        model_id=ANTHROPIC_CLAUDE_SONNET_ID,
        vendor=VENDOR_ANTHROPIC,
        provider_model="claude-sonnet-4-5",
        display_name="Claude Sonnet 4.5",
        billed_via=BILLED_VIA_VENDOR,
        credential=CREDENTIAL_ANTHROPIC,
    ),
    ModelOption(
        model_id=GOOGLE_GEMINI_FLASH_ID,
        vendor=VENDOR_GOOGLE,
        provider_model="gemini-2.5-flash",
        display_name="Gemini 2.5 Flash",
        billed_via=BILLED_VIA_VENDOR,
        credential=CREDENTIAL_GOOGLE,
    ),
)


@dataclass(frozen=True)
class DeploymentCredentials:
    """Secrets and IAM flags that decide which catalog entries are live."""

    openai_api_key: str = ""
    anthropic_api_key: str = ""
    google_api_key: str = ""
    bedrock_enabled: bool = False

    def allows(self, credential: str) -> bool:
        """Return whether this deployment can call models that need ``credential``."""
        if credential == CREDENTIAL_OPENAI:
            return bool(self.openai_api_key)
        if credential == CREDENTIAL_ANTHROPIC:
            return bool(self.anthropic_api_key)
        if credential == CREDENTIAL_GOOGLE:
            return bool(self.google_api_key)
        if credential == CREDENTIAL_BEDROCK:
            return self.bedrock_enabled
        return False


class ModelCatalog:
    """The models a deployment may put on the turn selector."""

    def __init__(
        self,
        options: tuple[ModelOption, ...] = (),
        *,
        default_model_id: str | None = None,
    ) -> None:
        self._by_id = {option.model_id: option for option in options}
        self._options = options
        self._default_model_id = default_model_id

    def available(self) -> tuple[ModelOption, ...]:
        """Return every model this deployment can call, in selector order."""
        return self._options

    def default(self) -> ModelOption | None:
        """Return the deployment default, or None when the catalog is empty."""
        if not self._options:
            return None
        if self._default_model_id is not None:
            option = self._by_id.get(self._default_model_id)
            if option is not None:
                return option
        return self._options[0]

    def get(self, model_id: str) -> ModelOption:
        """Return one catalog entry.

        :raises UnknownModelError: If ``model_id`` is not available here.
        """
        option = self._by_id.get(model_id)
        if option is None:
            raise UnknownModelError(
                f"Model {model_id!r} is not available on this deployment."
            )
        return option

    def resolve(self, model_id: str | None) -> ModelOption | None:
        """Return the selected model, or the default when none was sent.

        :raises UnknownModelError: If a non-empty ``model_id`` is unavailable.
        """
        requested = (model_id or "").strip()
        if not requested:
            return self.default()
        return self.get(requested)


def catalog_from_credentials(
    credentials: DeploymentCredentials,
    *,
    default_model_id: str | None = None,
) -> ModelCatalog:
    """Return the known models this deployment's credentials can actually call."""
    options = tuple(
        option for option in KNOWN_MODELS if credentials.allows(option.credential)
    )
    return ModelCatalog(options, default_model_id=default_model_id)


def option_payload(option: ModelOption) -> dict[str, str]:
    """Return the JSON shape GET /models and the composer share."""
    return {
        "model_id": option.model_id,
        "vendor": option.vendor,
        "display_name": option.display_name,
        "billed_via": option.billed_via,
    }
