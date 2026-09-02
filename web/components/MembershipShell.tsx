"use client";

import { EnabledWorkspace } from "./EnabledWorkspace";
import { CreateOrganizationPanel } from "./CreateOrganizationPanel";
import { NoOrganizationPanel } from "./NoOrganizationPanel";
import { WelcomeOrganizationPanel } from "./WelcomeOrganizationPanel";
import { SignInPanel, SignedInHeader } from "./SignInPanel";
import { useMembership } from "../lib/membership-context";
import { readSignupModeFromEnv } from "../lib/signup-mode";

export function MembershipShell() {
  const { authLoading, meLoading, branch, activeOrg, error } = useMembership();
  const signupMode = readSignupModeFromEnv();

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

      {branch === "no-org" && signupMode === "open" ? <CreateOrganizationPanel /> : null}
      {branch === "no-org" && signupMode === "invitation_only" ? (
        <NoOrganizationPanel />
      ) : null}
      {branch === "pending" ? <WelcomeOrganizationPanel /> : null}
      {branch === "enabled" && activeOrg ? (
        <EnabledWorkspace activeOrg={activeOrg} />
      ) : null}
    </main>
  );
}
