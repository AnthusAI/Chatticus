"use client";

import { SignInPanel } from "./SignInPanel";

export function NoOrganizationPanel() {
  return (
    <section className="card membership">
      <h2>No organization</h2>
      <p className="status">
        You are signed in, but no Chatticus organization is linked to this account
        yet.
      </p>
      <p className="status">
        Ask an operator to invite you or seed your household before using the
        workspace.
      </p>
    </section>
  );
}
