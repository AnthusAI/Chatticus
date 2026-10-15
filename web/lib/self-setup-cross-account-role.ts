import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";

export type SubmitSelfSetupCrossAccountRoleRequest = {
  account_id: string;
  cross_account_role: string;
  monthly_aws_spend_ceiling_usd: string;
};

export type SubmitSelfSetupCrossAccountRoleResponse = {
  accepted: true;
  tenant_id: string;
  name: string;
  status: "enabled";
  monthly_aws_spend_ceiling_usd: string;
};

export async function submitSelfSetupCrossAccountRole(
  tenantId: string,
  body: SubmitSelfSetupCrossAccountRoleRequest,
): Promise<SubmitSelfSetupCrossAccountRoleResponse> {
  const response = await fetch(`${apiBase}/orgs/${tenantId}/self-setup/cross-account-role`, {
    method: "POST",
    headers: {
      ...(await authorizedHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed.detail) {
        detail = parsed.detail;
      }
    } catch {
      // keep raw body
    }
    throw new Error(detail);
  }
  return (await response.json()) as SubmitSelfSetupCrossAccountRoleResponse;
}

export const CUSTOMER_ROLE_TEMPLATE_PATH = "/provisioning/customer-role.yml";
