import type { MeOrganization } from "./me";

export const SPEND_CEILING_FORM_TITLE = "Raise the monthly AWS spend ceiling";
export const SPEND_CEILING_MEMBER_GUIDANCE =
  "An owner of this organization can raise the monthly AWS spend ceiling to resume computer work.";
export const SPEND_CEILING_INVALID_MESSAGE = "Enter a positive dollar amount, like 500 or 250.50.";

export type SpendCeilingInput = { ok: true; amount: string } | { ok: false; message: string };

const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

export function canRaiseSpendCeiling(organization: MeOrganization | undefined): boolean {
  return organization?.computer_work_paused === true && organization.role === "owner";
}

export function parseSpendCeilingInput(raw: string): SpendCeilingInput {
  const trimmed = raw.trim();
  if (!AMOUNT_PATTERN.test(trimmed) || Number(trimmed) <= 0) {
    return { ok: false, message: SPEND_CEILING_INVALID_MESSAGE };
  }
  return { ok: true, amount: trimmed };
}

export function spendCeilingConfirmationText(amount: string): string {
  return `Monthly AWS spend ceiling is now $${amount}.`;
}

export function spendCeilingViewText(organization: MeOrganization | undefined): string | null {
  if (organization?.computer_work_paused !== true) {
    return null;
  }
  return canRaiseSpendCeiling(organization) ? SPEND_CEILING_FORM_TITLE : SPEND_CEILING_MEMBER_GUIDANCE;
}

const API_ERROR_PATTERN = /^HTTP (\d+): ([\s\S]*)$/;

export function spendCeilingErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const match = API_ERROR_PATTERN.exec(raw);
  if (!match) {
    return "The ceiling could not be changed. Try again.";
  }
  if (match[1] === "403") {
    return "Only an owner of this organization can change the ceiling.";
  }
  try {
    const detail = (JSON.parse(match[2]) as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) {
      return detail;
    }
  } catch {
    return "The ceiling could not be changed. Try again.";
  }
  return "The ceiling could not be changed. Try again.";
}
