"use client";

import { useEffect, useState } from "react";

import { completeSilentSignInCallback } from "../../../lib/auth";

export default function AuthSilentCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await completeSilentSignInCallback();
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "silent sign-in failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main>
        <section className="card auth">
          <h2>Silent sign-in failed</h2>
          <p className="status error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="card auth">
        <h2>Completing silent sign-in…</h2>
      </section>
    </main>
  );
}
