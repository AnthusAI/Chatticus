"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { completeSignInRedirect } from "../../../lib/auth";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await completeSignInRedirect();
        if (!cancelled) {
          router.replace("/");
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "sign-in failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (error) {
    return (
      <main>
        <section className="card auth">
          <h2>Sign in failed</h2>
          <p className="status error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="card auth">
        <h2>Completing sign-in…</h2>
        <p className="status">Exchanging authorization code for tokens.</p>
      </section>
    </main>
  );
}
