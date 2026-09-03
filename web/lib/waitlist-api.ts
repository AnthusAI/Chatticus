import { apiBase } from "./config";
import { getStoredUtmParams, type UtmParams } from "./analytics";

export type { UtmParams };

export type WaitlistSurveyChoice = {
  value: string;
  label: string;
};

export type WaitlistSurveyQuestion = {
  id: string;
  prompt: string;
  choices?: WaitlistSurveyChoice[];
};

export type WaitlistSurvey = {
  fit?: WaitlistSurveyQuestion[];
  aws_readiness?: WaitlistSurveyQuestion[];
  price?: WaitlistSurveyQuestion[];
  setup_path?: WaitlistSurveyQuestion[];
  price_sensitivity?: WaitlistSurveyQuestion[];
  professional_services_interest?: WaitlistSurveyQuestion[];
  training_interest?: WaitlistSurveyQuestion[];
};

export type PriceSensitivityAnswers = {
  too_cheap: string;
  bargain: string;
  expensive: string;
  too_expensive: string;
};

export type SubmitWaitlistPayload = {
  email: string;
  fit_answers: Record<string, string>;
  aws_readiness_answers: Record<string, string>;
  price_answers: Record<string, string>;
  setup_path_answers: Record<string, string>;
  price_sensitivity_answers?: PriceSensitivityAnswers;
  complete: boolean;
} & UtmParams;

type FetchFn = typeof fetch;

let fetchImpl: FetchFn = fetch;

/** Test-only hook to stub waitlist API fetch calls. */
export function setFetchForTests(source: FetchFn | null): void {
  fetchImpl = source ?? fetch;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text();
    throw new WaitlistApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export class WaitlistApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`HTTP ${status}: ${detail}`);
    this.status = status;
  }
}

export type WaitlistConfirmStatus =
  | "confirmed"
  | "invalid_token"
  | "already_confirmed";

export type WaitlistConfirmResponse = {
  status: WaitlistConfirmStatus;
  message: string;
};

export type WaitlistInviteStatus =
  | "accepted"
  | "invalid_token"
  | "expired"
  | "already_used";

export type WaitlistInviteResponse = {
  status: WaitlistInviteStatus;
  message: string;
  sign_in_url?: string | null;
};

export async function confirmWaitlistEmail(
  email: string,
  token: string,
): Promise<WaitlistConfirmResponse> {
  const params = new URLSearchParams({ email, token });
  const response = await fetchImpl(`${apiBase}/waitlist/confirm?${params}`);
  return readJson<WaitlistConfirmResponse>(response);
}

export async function consumeWaitlistInvitation(
  token: string,
): Promise<WaitlistInviteResponse> {
  const params = new URLSearchParams({ token });
  const response = await fetchImpl(`${apiBase}/waitlist/invite?${params}`);
  return readJson<WaitlistInviteResponse>(response);
}

export async function fetchWaitlistSurvey(): Promise<WaitlistSurvey> {
  const response = await fetchImpl(`${apiBase}/waitlist/survey`);
  return readJson<WaitlistSurvey>(response);
}

export async function submitWaitlist(payload: SubmitWaitlistPayload): Promise<void> {
  const utmParams = getStoredUtmParams();
  const body = {
    ...payload,
    ...utmParams,
  };
  const response = await fetchImpl(`${apiBase}/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await readJson<{ status: string }>(response);
}
