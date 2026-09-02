import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";

export type CreateOrganizationResponse = {
  tenant_id: string;
  name: string;
  status: "pending" | "enabled" | "suspended";
};

export async function createOrganization(name: string): Promise<CreateOrganizationResponse> {
  const response = await fetch(`${apiBase}/organizations`, {
    method: "POST",
    headers: {
      ...(await authorizedHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return (await response.json()) as CreateOrganizationResponse;
}
