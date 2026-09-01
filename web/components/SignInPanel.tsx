"use client";

import { useAuth } from "../lib/auth-context";

export function SignInPanel() {
  const { loading, session, error, signIn, signOut } = useAuth();

  if (loading) {
    return (
      <section className="card auth">
        <h2>Sign in</h2>
        <p className="status">Checking session…</p>
      </section>
    );
  }

  if (session) {
    return (
      <section className="card auth">
        <h2>Sign in</h2>
        <p className="status ok">
          Signed in{session.email ? ` as ${session.email}` : ""} with a verified
          id_token.
        </p>
        <button type="button" className="retry-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </section>
    );
  }

  return (
    <section className="card auth">
      <h2>Sign in</h2>
      <p className="status">Sign in with Google to obtain a verified Cognito id_token.</p>
      {error ? <p className="status error">{error}</p> : null}
      <button type="button" className="retry-button" onClick={() => void signIn()}>
        Sign in with Google
      </button>
    </section>
  );
}
