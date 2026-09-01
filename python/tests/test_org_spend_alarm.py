"""Org spend alarm stack: fail-closed parameters and bounded deploy."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra"
DEPLOY_SCRIPT = INFRA / "deploy-chatticus-org-spend-alarm.sh"


def _cdk_synth(
    *extra_args: str,
    output_dir: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    command = ["npx", "cdk", "synth", *extra_args]
    if output_dir is not None:
        command.extend(["--output", str(output_dir)])
    return subprocess.run(
        command,
        cwd=INFRA,
        capture_output=True,
        text=True,
        check=False,
    )


def test_org_spend_alarm_deploy_script_is_one_stack() -> None:
    text = DEPLOY_SCRIPT.read_text()
    assert "cdk deploy ChatticusOrgSpendAlarm --require-approval never" in text
    assert "deploy --all" not in text
    assert "ChatticusComputers" not in text
    assert "ChatticusSnapshots" not in text
    assert "ChatticusThinTurn" not in text
    assert "aws sts get-caller-identity" in text
    assert "CHATTICUS_ORG_SPEND_MONTHLY_USD" in text
    assert "CHATTICUS_ORG_SPEND_NOTIFICATION_EMAIL" in text
    assert "orgSpendMonthlyUsd=" in text
    assert "orgSpendNotificationEmail=" in text


def test_org_spend_alarm_deploy_script_refuses_missing_parameters() -> None:
    env = os.environ.copy()
    env.pop("CHATTICUS_ORG_SPEND_MONTHLY_USD", None)
    env.pop("CHATTICUS_ORG_SPEND_NOTIFICATION_EMAIL", None)
    result = subprocess.run(
        ["sh", str(DEPLOY_SCRIPT)],
        cwd=INFRA,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "CHATTICUS_ORG_SPEND_MONTHLY_USD" in result.stderr
    assert "CHATTICUS_ORG_SPEND_NOTIFICATION_EMAIL" in result.stderr


def test_org_spend_alarm_stack_source_has_budget_and_forecast() -> None:
    stack = (INFRA / "lib" / "org-spend-alarm-stack.ts").read_text()
    config = (INFRA / "lib" / "org-spend-alarm-config.ts").read_text()
    assert "CfnBudget" in stack
    assert "notificationsWithSubscribers" in stack
    assert 'notificationType: "ACTUAL"' in stack
    assert 'notificationType: "FORECASTED"' in stack
    assert "AWSBudgetsSNSPublishingPermissions" in stack
    assert "EmailSubscription" in stack
    assert "Refusing to synth or deploy with invented defaults" in config


def test_org_spend_alarm_partial_context_fails_synth() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        result = _cdk_synth(
            "-c",
            "orgSpendMonthlyUsd=100",
            output_dir=Path(tmp) / "partial",
        )
    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "orgSpendNotificationEmail" in combined


@pytest.fixture(scope="module")
def org_spend_alarm_template() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        output_dir = Path(tmp) / "org-spend"
        result = _cdk_synth(
            "ChatticusOrgSpendAlarm",
            "-c",
            "orgSpendMonthlyUsd=250",
            "-c",
            "orgSpendNotificationEmail=owner@example.com",
            output_dir=output_dir,
        )
        assert result.returncode == 0, result.stderr
        template_path = output_dir / "ChatticusOrgSpendAlarm.template.json"
        return json.loads(template_path.read_text())


def test_org_spend_alarm_template_has_budget_notifications(
    org_spend_alarm_template: dict,
) -> None:
    resources = org_spend_alarm_template["Resources"]
    budgets = [
        resource
        for resource in resources.values()
        if resource.get("Type") == "AWS::Budgets::Budget"
    ]
    assert len(budgets) == 1
    notifications = budgets[0]["Properties"]["NotificationsWithSubscribers"]
    assert len(notifications) == 4
    actual = [
        item["Notification"]["Threshold"]
        for item in notifications
        if item["Notification"]["NotificationType"] == "ACTUAL"
    ]
    assert actual == [50, 80, 100]
    forecasted = [
        item
        for item in notifications
        if item["Notification"]["NotificationType"] == "FORECASTED"
    ]
    assert len(forecasted) == 1
    assert forecasted[0]["Notification"]["Threshold"] == 100


def test_org_spend_alarm_template_uses_sns_topic(
    org_spend_alarm_template: dict,
) -> None:
    resources = org_spend_alarm_template["Resources"]
    topics = [
        resource
        for resource in resources.values()
        if resource.get("Type") == "AWS::SNS::Topic"
    ]
    assert len(topics) == 1
    topic_logical_id = next(
        key for key, value in resources.items() if value is topics[0]
    )
    subscriptions = [
        resource
        for resource in resources.values()
        if resource.get("Type") == "AWS::SNS::Subscription"
    ]
    assert len(subscriptions) == 1
    assert topic_logical_id in subscriptions[0]["Properties"]["TopicArn"]["Ref"]

    budget = next(
        resource
        for resource in resources.values()
        if resource.get("Type") == "AWS::Budgets::Budget"
    )
    for notification in budget["Properties"]["NotificationsWithSubscribers"]:
        subscriber = notification["Subscribers"][0]
        assert subscriber["SubscriptionType"] == "SNS"
        assert topic_logical_id in subscriber["Address"]["Ref"]
