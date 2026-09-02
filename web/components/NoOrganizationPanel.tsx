"use client";

import { AuthCard, authStatusClassName } from "./AuthCard";

export function NoOrganizationPanel() {
  return (
    <AuthCard title="No organization">
      <p className={authStatusClassName}>
        You are signed in, but no Chatticus organization is linked to this account
        yet.
      </p>
      <p className={authStatusClassName}>
        Ask an operator to invite you before using the workspace.
      </p>
    </AuthCard>
  );
}
