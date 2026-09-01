import * as cdk from "aws-cdk-lib";

export const BUDGETS_OWNER_STACK_ID = "ChatticusSnapshots";

export interface BudgetsConfig {
  readonly monthlyLimitUsd: number;
  readonly notificationEmails: readonly string[];
}

function contextProvided(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  return String(value).trim() !== "";
}

/**
 * Read budget parameters from CDK context.
 *
 * Returns undefined when neither parameter is set so default ``cdk synth``
 * (CI) can synthesize without budget resources. Partial or invalid values
 * throw so deploy cannot proceed with invented defaults.
 */
export function readBudgetsConfig(
  scope: cdk.App | cdk.Stack,
): BudgetsConfig | undefined {
  const monthlyRaw = scope.node.tryGetContext("budgetsMonthlyLimitUsd");
  const emailRaw = scope.node.tryGetContext("budgetsNotificationEmail");
  const hasMonthly = contextProvided(monthlyRaw);
  const hasEmail = contextProvided(emailRaw);

  if (!hasMonthly && !hasEmail) {
    return undefined;
  }

  if (!hasMonthly || !hasEmail) {
    throw new Error(
      `${BUDGETS_OWNER_STACK_ID} budgets require both ` +
        "-c budgetsMonthlyLimitUsd=<amount> and " +
        "-c budgetsNotificationEmail=<address>. " +
        "Refusing to synth or deploy with invented defaults.",
    );
  }

  const monthlyLimitUsd = Number(monthlyRaw);
  if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0) {
    throw new Error(
      `budgetsMonthlyLimitUsd must be a positive number, got: ${String(monthlyRaw)}`,
    );
  }

  const notificationEmail = String(emailRaw).trim();
  if (!notificationEmail.includes("@")) {
    throw new Error(
      `budgetsNotificationEmail must be an email address, got: ${notificationEmail}`,
    );
  }

  return { monthlyLimitUsd, notificationEmails: [notificationEmail] };
}
