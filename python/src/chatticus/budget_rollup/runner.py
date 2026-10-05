"""Daily budget rollup combining AWS Cost Explorer and vendor ledger meters."""

from __future__ import annotations

ROLLUP_ALERT_SOURCE = "chatticus.daily_rollup"
DEFAULT_THRESHOLD_BANDS = (50, 80, 100)
CE_STATUS_OK = "ok"
CE_STATUS_PENDING = "pending"
CE_STATUS_ERROR = "error"
