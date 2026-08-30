"""Fault-injection hooks shared by the control plane and tests."""

from __future__ import annotations

from enum import StrEnum


class TurnBoundary(StrEnum):
    """Durable steps in one bot turn."""

    MESSAGE_COMMIT = "message_commit"
    LOGICAL_ENQUEUE = "logical_enqueue"
    WORKER_CLAIM = "worker_claim"
    MODEL_ACCEPTANCE = "model_acceptance"
    PROGRESS_APPEND = "progress_append"
    COMPLETION_APPEND = "completion_append"
    ACKNOWLEDGEMENT = "acknowledgement"
    DEADLINE_RECOVERY = "deadline_recovery"


class CrashWindow(StrEnum):
    """Whether the crash happens before or after the durable write."""

    BEFORE = "before"
    AFTER = "after"


class SimulatedCrash(Exception):
    """Raised when a fault-injection hook fires."""

    def __init__(self, boundary: TurnBoundary, window: CrashWindow) -> None:
        self.boundary = boundary
        self.window = window
        super().__init__(f"simulated crash {boundary} {window}")


class FaultInjector:
    """Fire at most one deterministic crash per scenario."""

    def __init__(self) -> None:
        self._armed: tuple[TurnBoundary, CrashWindow] | None = None
        self.crashed_at: tuple[TurnBoundary, CrashWindow] | None = None

    def arm(self, boundary: TurnBoundary, window: CrashWindow) -> None:
        """Arm the next operation at ``boundary`` / ``window``."""
        self._armed = (boundary, window)
        self.crashed_at = None

    def clear(self) -> None:
        """Disable further crashes."""
        self._armed = None

    def maybe_crash(self, boundary: TurnBoundary, window: CrashWindow) -> None:
        """Raise ``SimulatedCrash`` when armed at this hook."""
        if self._armed != (boundary, window) or self.crashed_at is not None:
            return
        self.crashed_at = (boundary, window)
        raise SimulatedCrash(boundary, window)
