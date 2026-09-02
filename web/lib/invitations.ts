import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";

export type CreateInvitationResponse = {
  invitation_id: string;
  email: string;
  expires_at: string;
};

export function inviteConfirmationText(email: string): string {
  return `Invited ${email} — they can sign in with that Google account.`;
}

export async function inviteMember(
  tenantId: string,
  email: string,
): Promise<CreateInvitationResponse> {
  const response = await fetch(`${apiBase}/orgs/${tenantId}/invitations`, {
    method: "POST",
    headers: {
      ...(await authorizedHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return (await response.json()) as CreateInvitationResponse;
}
