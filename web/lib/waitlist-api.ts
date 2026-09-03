import { apiBase } from "./config";

export type WaitlistSurveyQuestion = {
  id: string;
  prompt: string;
  choices?: string[];
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
};

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

export async function fetchWaitlistSurvey(): Promise<WaitlistSurvey> {
  const response = await fetchImpl(`${apiBase}/waitlist/survey`);
  return readJson<WaitlistSurvey>(response);
}

export async function submitWaitlist(payload: SubmitWaitlistPayload): Promise<void> {
  const response = await fetchImpl(`${apiBase}/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await readJson<{ status: string }>(response);
}
