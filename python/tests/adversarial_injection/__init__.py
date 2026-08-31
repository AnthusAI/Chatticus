"""Adversarial browser injection eval harness (test-only)."""

from adversarial_injection.cases import (
    ALL_CASES,
    ALLOWED_CASES,
    FORBIDDEN_CASES,
    InjectionCase,
)
from adversarial_injection.compliant_model import CompliantInjectionModel, SinkRequest
from adversarial_injection.driver import (
    AdversarialInjectionDriver,
    EvalOutcome,
    load_fixture_html,
)

__all__ = [
    "ALL_CASES",
    "ALLOWED_CASES",
    "FORBIDDEN_CASES",
    "AdversarialInjectionDriver",
    "CompliantInjectionModel",
    "EvalOutcome",
    "InjectionCase",
    "SinkRequest",
    "load_fixture_html",
]
