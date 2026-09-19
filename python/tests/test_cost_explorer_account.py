from decimal import Decimal
from pathlib import Path

import pytest

from chatticus.cost_explorer import (
    AccountSpendUnreadableError,
    account_day_from_response,
)
from chatticus.cross_account_provisioning import PROVISIONING_REQUIRED_PERMISSIONS

CUSTOMER_ROLE = Path(__file__).resolve().parents[2] / "infra" / "customer-role.yml"


def test_account_day_reads_the_total_unblended_cost() -> None:
    response = {"ResultsByTime": [{"Total": {"UnblendedCost": {"Amount": "22.3487"}}}]}
    day = account_day_from_response(response)
    assert day.pending is False
    assert day.total_usd == Decimal("22.3487")


def test_account_day_with_no_results_is_pending_not_zero() -> None:
    day = account_day_from_response({"ResultsByTime": []})
    assert day.pending is True
    assert day.total_usd is None


def test_account_day_with_a_malformed_total_is_unreadable() -> None:
    with pytest.raises(AccountSpendUnreadableError):
        account_day_from_response({"ResultsByTime": [{"Total": {}}]})


def test_customer_role_template_grants_every_required_permission() -> None:
    text = CUSTOMER_ROLE.read_text()
    missing = [
        permission
        for permission in PROVISIONING_REQUIRED_PERMISSIONS
        if f"'{permission}'" not in text
    ]
    assert missing == []
