import * as cdk from "aws-cdk-lib";

export const ORG_SPEND_ALARM_STACK_ID = "ChatticusOrgSpendAlarm";

export interface OrgSpendAlarmConfig {
  readonly monthlyUsd: number;
  readonly notificationEmail: string;
}

function contextProvided(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  return String(value).trim() !== "";
}

/**
 * Read org-spend alarm parameters from CDK context.
 *
 * Returns undefined when neither parameter is set so default ``cdk synth``
 * (CI) can synthesize the other stacks. Partial or invalid values throw so
 * deploy cannot proceed with invented defaults.
 */
export function readOrgSpendAlarmConfig(
  scope: cdk.App | cdk.Stack,
): OrgSpendAlarmConfig | undefined {
  const monthlyRaw = scope.node.tryGetContext("orgSpendMonthlyUsd");
  const emailRaw = scope.node.tryGetContext("orgSpendNotificationEmail");
  const hasMonthly = contextProvided(monthlyRaw);
  const hasEmail = contextProvided(emailRaw);

  if (!hasMonthly && !hasEmail) {
    return undefined;
  }

  if (!hasMonthly || !hasEmail) {
    throw new Error(
      `${ORG_SPEND_ALARM_STACK_ID} requires both ` +
        "-c orgSpendMonthlyUsd=<amount> and " +
        "-c orgSpendNotificationEmail=<address>. " +
        "Refusing to synth or deploy with invented defaults.",
    );
  }

  const monthlyUsd = Number(monthlyRaw);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
    throw new Error(
      `orgSpendMonthlyUsd must be a positive number, got: ${String(monthlyRaw)}`,
    );
  }

  const notificationEmail = String(emailRaw).trim();
  if (!notificationEmail.includes("@")) {
    throw new Error(
      `orgSpendNotificationEmail must be an email address, got: ${notificationEmail}`,
    );
  }

  return { monthlyUsd, notificationEmail };
}
