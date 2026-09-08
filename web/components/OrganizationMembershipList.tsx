"use client";

import { authStatusClassName } from "./AuthCard";
import type { MeOrganization } from "../lib/me";
import { sortOrganizationMembershipRows } from "../lib/organization-membership";

type OrganizationMembershipListProps = {
  organizations: MeOrganization[];
};

export function OrganizationMembershipList({
  organizations,
}: OrganizationMembershipListProps) {
  if (organizations.length === 0) {
    return null;
  }

  const rows = sortOrganizationMembershipRows(organizations);

  return (
    <section className="grid gap-3">
      {rows.map((organization) => (
        <article
          key={organization.tenant_id}
          className="rounded-2xl bg-surface-raised p-4 text-surface-foreground sm:p-5"
        >
          <p className="font-body text-base font-extrabold">{organization.name}</p>
          <p className={authStatusClassName}>Status: {organization.status}</p>
          <p className={authStatusClassName}>
            Organization ID: <code>{organization.tenant_id}</code>
          </p>
        </article>
      ))}
    </section>
  );
}
