"use client";

import { EnabledWorkspace } from "./EnabledWorkspace";
import { NoOrganizationPanel } from "./NoOrganizationPanel";
import { PendingOrganizationPanel } from "./PendingOrganizationPanel";
import { SignInPanel, SignedInHeader } from "./SignInPanel";
import { useMembership } from "../lib/membership-context";

export function MembershipShell() {
  const { authLoading, meLoading, branch, activeOrg, error } = useMembership();

  if (authLoading || (branch !== "signed-out" && meLoading)) {
    return (
      <main>
        <header className="site-header">
          <h1>Chatticus</h1>
          <p className="status">Loading membership…</p>
        </header>
      </main>
    );
  }

  if (branch === "signed-out") {
    return (
      <main>
        <header className="site-header">
          <h1>Chatticus</h1>
          <p>Named bots, one shared computer, serverless control plane.</p>
        </header>
        <SignInPanel />
      </main>
    );
  }

  return (
    <main>
      <header className="site-header">
        <h1>Chatticus</h1>
        <p>Named bots, one shared computer, serverless control plane.</p>
      </header>

      <SignedInHeader />

      {error ? (
        <section className="card membership">
          <p className="status error">{error}</p>
        </section>
      ) : null}

      {branch === "no-org" ? <NoOrganizationPanel /> : null}
      {branch === "pending" ? <PendingOrganizationPanel /> : null}
      {branch === "enabled" && activeOrg ? (
        <EnabledWorkspace activeOrg={activeOrg} />
      ) : null}
    </main>
  );
}
