"use client";

import { useMembership } from "../lib/membership-context";

export function SignInPanel() {
  const { authLoading, error, signIn } = useMembership();

  if (authLoading) {
    return (
      <section className="card auth">
        <h2>Sign in</h2>
        <p className="status">Checking session…</p>
      </section>
    );
  }

  return (
    <section className="card auth">
      <h2>Sign in</h2>
      <p className="status">Sign in with Google to use Chatticus.</p>
      {error ? <p className="status error">{error}</p> : null}
      <button type="button" className="retry-button" onClick={() => void signIn()}>
        Sign in with Google
      </button>
    </section>
  );
}

function SignedInHeader() {
  const { session, signOut } = useMembership();
  return (
    <section className="card auth">
      <p className="status ok">
        Signed in{session?.email ? ` as ${session.email}` : ""}.
      </p>
      <button type="button" className="retry-button" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}

export { SignedInHeader };
