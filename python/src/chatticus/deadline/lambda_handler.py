"""Lambda target for EventBridge Scheduler turn-deadline one-shots."""

from __future__ import annotations

import logging
from typing import Any

from chatticus.runtime import plane_from_env

logger = logging.getLogger("chatticus.deadline")


def handler(event: dict[str, Any], _context: object) -> None:
    """Invoke turn recovery when a scheduled watchdog fires."""
    tenant_id = event["tenant_id"]
    turn_id = event["turn_id"]
    logger.info(
        "turn_deadline_fired tenant_id=%s turn_id=%s",
        tenant_id,
        turn_id,
    )
    plane_from_env().handle_turn_deadline(tenant_id, turn_id)
