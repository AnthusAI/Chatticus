import { getIdToken } from "./auth";

type IdTokenSource = () => Promise<string | null>;

let idTokenSource: IdTokenSource = getIdToken;

/** Test-only hook to stub how authorizedHeaders reads the session token. */
export function setIdTokenSourceForTests(source: IdTokenSource | null): void {
  idTokenSource = source ?? getIdToken;
}

/** Headers including Bearer id_token when a session exists. */
export async function authorizedHeaders(
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };
  const token = await idTokenSource();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
