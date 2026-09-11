"""Vendor-neutral LLM catalog and completion adapters."""

from chatticus.llm.catalog import (
    ModelCatalog,
    ModelOption,
    catalog_from_credentials,
    option_payload,
)
from chatticus.llm.credentials import credentials_from_env, default_model_id_from_env

__all__ = [
    "ModelCatalog",
    "ModelOption",
    "catalog_from_credentials",
    "credentials_from_env",
    "default_model_id_from_env",
    "option_payload",
]
