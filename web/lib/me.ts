import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";

export type MeOrganization = {
  tenant_id: string;
  status: "pending" | "enabled" | "suspended";
};

export type MeResponse = {
  email: string;
  user_id: string | null;
  organizations: MeOrganization[];
};

export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch(`${apiBase}/me`, {
    headers: await authorizedHeaders(),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return (await response.json()) as MeResponse;
}
