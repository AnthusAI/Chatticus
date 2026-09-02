"""Lambda entrypoint for scheduled and on-demand live integration tests."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from chatticus.integration_test.runner import run_smoke

logger = logging.getLogger("chatticus.integration_test")


def handler(event: dict[str, Any], _context: object) -> dict[str, str]:
    """Run the smoke-tier integration test and return structured JSON."""
    tier = str(event.get("tier") or "smoke").strip().lower()
    if tier != "smoke":
        msg = f"Unsupported integration test tier {tier!r}; only smoke is implemented."
        raise RuntimeError(msg)
    environment = os.environ.get(
        "CHATTICUS_INTEGRATION_TEST_ENVIRONMENT", "development"
    )
    logger.info("integration_test_start environment=%s tier=%s", environment, tier)
    result = run_smoke(environment=environment)
    payload = {
        "status": result.status,
        "checks": result.checks,
        "error": result.error,
    }
    logger.info("integration_test_complete payload=%s", json.dumps(payload))
    if result.status != "pass":
        raise RuntimeError(result.error or "integration test failed")
    return payload
