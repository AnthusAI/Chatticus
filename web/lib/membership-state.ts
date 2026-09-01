import type { VerifiedSession } from "./auth";
import type { MeResponse } from "./me";

export type MembershipBranch =
  | "signed-out"
  | "no-org"
  | "pending"
  | "enabled";

export type ActiveOrg = {
  tenantId: string;
  userId: string;
};

export function deriveMembershipBranch(
  session: VerifiedSession | null,
  me: MeResponse | null,
): MembershipBranch {
  if (!session) {
    return "signed-out";
  }
  if (!me) {
    return "signed-out";
  }
  if (me.user_id === null || me.organizations.length === 0) {
    return "no-org";
  }
  if (me.organizations.some((organization) => organization.status === "enabled")) {
    return "enabled";
  }
  if (me.organizations.some((organization) => organization.status === "pending")) {
    return "pending";
  }
  return "no-org";
}

export function pickActiveOrg(me: MeResponse): ActiveOrg | null {
  if (!me.user_id) {
    return null;
  }
  const enabled = me.organizations
    .filter((organization) => organization.status === "enabled")
    .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
  if (enabled.length > 0) {
    return { tenantId: enabled[0].tenant_id, userId: me.user_id };
  }
  const pending = me.organizations
    .filter((organization) => organization.status === "pending")
    .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
  if (pending.length > 0) {
    return { tenantId: pending[0].tenant_id, userId: me.user_id };
  }
  return null;
}
