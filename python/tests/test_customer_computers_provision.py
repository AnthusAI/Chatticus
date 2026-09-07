"""Unit tests for customer ChatticusComputers provisioning helpers."""

from __future__ import annotations

from chatticus.customer_computers_provision import (
    TERMINAL_FAILED_RECOVERABLE_STATUSES,
    is_recoverable_terminal_failed_status,
)


def test_is_recoverable_terminal_failed_status_true_cases() -> None:
    for status in TERMINAL_FAILED_RECOVERABLE_STATUSES:
        assert is_recoverable_terminal_failed_status(status) is True


def test_is_recoverable_terminal_failed_status_false_cases() -> None:
    assert is_recoverable_terminal_failed_status("CREATE_COMPLETE") is False
    assert is_recoverable_terminal_failed_status("CREATE_IN_PROGRESS") is False
    assert is_recoverable_terminal_failed_status("UPDATE_FAILED") is False
    assert is_recoverable_terminal_failed_status("DELETE_IN_PROGRESS") is False
