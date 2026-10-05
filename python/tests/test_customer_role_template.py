from pathlib import Path

from chatticus.cross_account_provisioning import PROVISIONING_REQUIRED_PERMISSIONS

CUSTOMER_ROLE = Path(__file__).resolve().parents[2] / "infra" / "customer-role.yml"


def test_customer_role_template_grants_every_required_permission() -> None:
    text = CUSTOMER_ROLE.read_text()
    missing = [
        permission
        for permission in PROVISIONING_REQUIRED_PERMISSIONS
        if f"'{permission}'" not in text
    ]
    assert missing == []
