"use client";

import { EnabledWorkspace } from "./EnabledWorkspace";
import { CreateOrganizationPanel } from "./CreateOrganizationPanel";
import { NoOrganizationPanel } from "./NoOrganizationPanel";
import { WelcomeOrganizationPanel } from "./WelcomeOrganizationPanel";
import { SignInPanel, SignedInHeader } from "./SignInPanel";
import { authErrorClassName, authStatusClassName } from "./AuthCard";
import { useMembership } from "../lib/membership-context";
import { readSignupModeFromEnv } from "../lib/signup-mode";

function ShellHeader() {
  return (
    <header className="grid gap-1 py-6 text-surface-foreground">
      <p className="font-body text-lg font-extrabold">
        chatticus<span className="text-clay">.</span>
      </p>
      <p className={authStatusClassName}>Named bots, one shared computer, serverless control plane.</p>
    </header>
  );
}

export function MembershipShell() {
  const { authLoading, meLoading, branch, activeOrg, error } = useMembership();
  const signupMode = readSignupModeFromEnv();

  if (authLoading || (branch !== "signed-out" && meLoading)) {
    return (
      <main className="mx-auto max-w-2xl bg-surface px-5">
        <ShellHeader />
        <p className={authStatusClassName}>Loading membership…</p>
      </main>
    );
  }

  if (branch === "signed-out") {
    return (
      <main className="mx-auto max-w-2xl bg-surface px-5">
        <ShellHeader />
        <SignInPanel />
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-2xl gap-3 bg-surface px-5 pb-10">
      <ShellHeader />

      <SignedInHeader />

      {error ? (
        <section className="rounded-2xl bg-surface-raised p-4">
          <p className={authErrorClassName}>{error}</p>
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
