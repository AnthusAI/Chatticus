from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from chatticus.cost_explorer import (
    AccountSpendUnreadableError,
    Boto3CostExplorerReader,
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


class _StubCostExplorer:
    def __init__(self, tags: object) -> None:
        self._tags = tags

    def get_cost_and_usage(self, **_kwargs: object) -> dict[str, object]:
        return {"ResultsByTime": [{"Groups": []}]}

    def list_cost_allocation_tags(self, **_kwargs: object) -> dict[str, object]:
        if isinstance(self._tags, Exception):
            raise self._tags
        return {"CostAllocationTags": self._tags}


def _tag_active(tags: object) -> bool:
    reader = Boto3CostExplorerReader(client=_StubCostExplorer(tags))
    day = reader.daily_costs_by_tenant(
        environment="development", rollup_date=date(2026, 9, 18)
    )
    return day.tenant_tag_active


def test_tenant_tag_reads_active_when_cost_explorer_lists_it() -> None:
    assert _tag_active([{"TagKey": "chatticus:tenant", "Status": "Active"}]) is True


def test_tenant_tag_reads_inactive_when_cost_explorer_does_not_list_it() -> None:
    assert _tag_active([]) is False


def test_tenant_tag_reads_inactive_when_the_lookup_fails() -> None:
    denied = ClientError({"Error": {"Code": "AccessDeniedException"}}, "ListTags")
    assert _tag_active(denied) is False
