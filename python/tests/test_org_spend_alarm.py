"""Org spend alarm: deploy script guards and source shape (no CDK synth)."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra"
DEPLOY_SCRIPT = INFRA / "deploy-chatticus-org-spend-alarm.sh"


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
    monthly_pos = text.index("CHATTICUS_ORG_SPEND_MONTHLY_USD")
    aws_pos = text.index("aws sts get-caller-identity")
    assert monthly_pos < aws_pos


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
