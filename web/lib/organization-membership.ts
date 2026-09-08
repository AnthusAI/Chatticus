import type { MeOrganization } from "./me";

export function sortOrganizationMembershipRows(
  organizations: MeOrganization[],
): MeOrganization[] {
  return [...organizations].sort((left, right) =>
    left.tenant_id.localeCompare(right.tenant_id),
  );
}

export function formatOrganizationMembershipRow(organization: MeOrganization): string {
  return [
    organization.name,
    `Status: ${organization.status}`,
    `Organization ID: ${organization.tenant_id}`,
  ].join("\n");
}

export function formatOrganizationMembershipList(
  organizations: MeOrganization[],
): string {
  return sortOrganizationMembershipRows(organizations)
    .map(formatOrganizationMembershipRow)
    .join("\n\n");
}

export function membershipVisibleText(
  viewText: string,
  organizations: MeOrganization[],
): string {
  if (organizations.length === 0) {
    return viewText;
  }
  return `${viewText}\n\n${formatOrganizationMembershipList(organizations)}`;
}
