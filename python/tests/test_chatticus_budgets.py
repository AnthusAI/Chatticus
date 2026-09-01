"""ChatticusBudgets: deploy context guards and construct source shape."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra"
BUDGETS_CONTEXT_SCRIPT = INFRA / "budgets-deploy-context.sh"
SNAPSHOTS_DEPLOY_SCRIPT = INFRA / "deploy-chatticus-snapshots.sh"
ORG_SPEND_DEPLOY_SCRIPT = INFRA / "deploy-chatticus-org-spend-alarm.sh"


def test_budgets_deploy_context_omits_flags_when_unset() -> None:
    env = os.environ.copy()
    env.pop("CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD", None)
    env.pop("CHATTICUS_BUDGETS_NOTIFICATION_EMAIL", None)
    result = subprocess.run(
        [
            "sh",
            "-c",
            f'. "{BUDGETS_CONTEXT_SCRIPT}"; printf "%s" "$BUDGETS_CDK_CONTEXT"',
        ],
        cwd=INFRA,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_budgets_deploy_context_refuses_partial_monthly_only() -> None:
    env = os.environ.copy()
    env["CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD"] = "100"
    env.pop("CHATTICUS_BUDGETS_NOTIFICATION_EMAIL", None)
    result = subprocess.run(
        ["sh", "-c", f'. "{BUDGETS_CONTEXT_SCRIPT}"'],
        cwd=INFRA,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "CHATTICUS_BUDGETS_NOTIFICATION_EMAIL" in result.stderr
    assert "Do not invent defaults" in result.stderr


def test_budgets_deploy_context_emits_cdk_flags_when_set() -> None:
    env = os.environ.copy()
    env["CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD"] = "75"
    env["CHATTICUS_BUDGETS_NOTIFICATION_EMAIL"] = "owner@example.com"
    result = subprocess.run(
        [
            "sh",
            "-c",
            f'. "{BUDGETS_CONTEXT_SCRIPT}"; printf "%s" "$BUDGETS_CDK_CONTEXT"',
        ],
        cwd=INFRA,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "budgetsMonthlyLimitUsd=75" in result.stdout
    assert "budgetsNotificationEmail=owner@example.com" in result.stdout


def test_snapshots_deploy_script_is_one_stack() -> None:
    text = SNAPSHOTS_DEPLOY_SCRIPT.read_text()
    assert "cdk deploy ChatticusSnapshots --require-approval never" in text
    assert "deploy --all" not in text
    assert "ChatticusComputers" not in text
    assert "ChatticusThinTurn" not in text
    assert "budgets-deploy-context.sh" in text
    assert "BUDGETS_CDK_CONTEXT" in text
    assert "CHATTICUS_BUDGETS_NOTIFICATION_EMAIL" in text


def test_org_spend_alarm_deploy_script_not_present() -> None:
    assert not ORG_SPEND_DEPLOY_SCRIPT.exists()


def test_chatticus_budgets_source_shape() -> None:
    construct = (INFRA / "lib" / "chatticus-budgets.ts").read_text()
    config = (INFRA / "lib" / "budgets-config.ts").read_text()
    assert "CfnBudget" in construct
    assert "notificationsWithSubscribers" in construct
    assert 'notificationType: "ACTUAL"' in construct
    assert 'notificationType: "FORECASTED"' in construct
    assert "AWSBudgetsSNSPublishingPermissions" in construct
    assert "EmailSubscription" in construct
    assert "chatticus-monthly-aws" in construct
    assert "Refusing to synth or deploy with invented defaults" in config
