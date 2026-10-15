"use client";

import { AuthCard, authStatusClassName } from "./AuthCard";
import { SelfSetupCrossAccountRolePanel } from "./SelfSetupCrossAccountRolePanel";
import { WELCOME_SCREEN_LINES, WELCOME_SCREEN_TITLE } from "../lib/membership-view";
import type { MeOrganization } from "../lib/me";
import { OrganizationMembershipList } from "./OrganizationMembershipList";

type WelcomeOrganizationPanelProps = {
  organizations: MeOrganization[];
};

export function WelcomeOrganizationPanel({
  organizations,
}: WelcomeOrganizationPanelProps) {
  const pendingOrganization = organizations.find(
    (organization) => organization.status === "pending",
  );

  return (
    <>
      <AuthCard title={WELCOME_SCREEN_TITLE}>
        {WELCOME_SCREEN_LINES.map((line) => (
          <p key={line} className={authStatusClassName}>
            {line}
          </p>
        ))}
      </AuthCard>
      <OrganizationMembershipList organizations={organizations} />
      {pendingOrganization ? (
        <SelfSetupCrossAccountRolePanel organization={pendingOrganization} />
      ) : null}
    </>
  );
}
