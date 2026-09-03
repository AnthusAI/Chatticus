import { apiBase } from "./config";

export type ContactType = "professional_services" | "professional_training";

export type SubmitContactPayload = {
  email: string;
  contact_type: ContactType;
  name?: string;
  organization?: string;
  details: Record<string, string>;
};

type FetchFn = typeof fetch;

let fetchImpl: FetchFn = fetch;

/** Test-only hook to stub contact API fetch calls. */
export function setFetchForTests(source: FetchFn | null): void {
  fetchImpl = source ?? fetch;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text();
    throw new ContactApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export class ContactApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`HTTP ${status}: ${detail}`);
    this.status = status;
  }
}

export async function submitContact(payload: SubmitContactPayload): Promise<void> {
  const response = await fetchImpl(`${apiBase}/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await readJson<{ status: string }>(response);
}
