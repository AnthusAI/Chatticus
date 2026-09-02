"use client";

import { AuthCard, authButtonClassName, authErrorClassName, authOkClassName, authStatusClassName } from "./AuthCard";
import { useMembership } from "../lib/membership-context";

export function SignInPanel() {
  const { authLoading, error, signIn } = useMembership();

  if (authLoading) {
    return (
      <AuthCard title="Sign in">
        <p className={authStatusClassName}>Checking session…</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in">
      <p className={authStatusClassName}>Sign in with Google to use Chatticus.</p>
      {error ? <p className={authErrorClassName}>{error}</p> : null}
      <button type="button" className={authButtonClassName} onClick={() => void signIn()}>
        Sign in with Google
      </button>
    </AuthCard>
  );
}

function SignedInHeader() {
  const { session, signOut } = useMembership();
  return (
    <AuthCard>
      <p className={authOkClassName}>
        Signed in{session?.email ? ` as ${session.email}` : ""}.
      </p>
      <button type="button" className={authButtonClassName} onClick={() => void signOut()}>
        Sign out
      </button>
    </AuthCard>
  );
}

export { SignedInHeader };
