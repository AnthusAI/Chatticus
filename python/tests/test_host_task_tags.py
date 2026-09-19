from chatticus.computer_start import HostStartClaim
from chatticus.cost_explorer import TENANT_TAG_KEY
from chatticus.organization_computer_host import host_task_tags


def _claim() -> HostStartClaim:
    return HostStartClaim(
        tenant_id="acme",
        computer_id="computer-1",
        host_start_count=3,
        user_id="ryan",
    )


def _as_dict(tags: list[dict[str, str]]) -> dict[str, str]:
    return {tag["key"]: tag["value"] for tag in tags}


def test_task_is_tagged_with_the_key_the_rollup_groups_by() -> None:
    tags = _as_dict(host_task_tags(_claim(), {}))
    assert tags[TENANT_TAG_KEY] == "acme"
    assert TENANT_TAG_KEY == "chatticus:tenant"


def test_task_carries_the_standard_cost_tags_when_configured() -> None:
    tags = _as_dict(
        host_task_tags(
            _claim(),
            {
                "CHATTICUS_ENVIRONMENT": "production",
                "CHATTICUS_INSTALLATION_NAME": " Anthus AI Solutions ",
            },
        )
    )
    assert tags["chatticus:application"] == "Chatticus"
    assert tags["chatticus:component"] == "computer"
    assert tags["chatticus:environment"] == "production"
    assert tags["chatticus:installation"] == "Anthus AI Solutions"


def test_environment_and_installation_are_left_off_when_unset() -> None:
    tags = _as_dict(host_task_tags(_claim(), {"CHATTICUS_INSTALLATION_NAME": "  "}))
    assert "chatticus:environment" not in tags
    assert "chatticus:installation" not in tags


def test_operational_tags_are_kept() -> None:
    tags = _as_dict(host_task_tags(_claim(), {}))
    assert tags["computer_id"] == "computer-1"
    assert tags["host_start_generation"] == "3"
