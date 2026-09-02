"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { completeSignOutRedirect } from "../../../lib/auth";

export default function SignOutCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await completeSignOutRedirect();
        if (!cancelled) {
          router.replace("/");
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "sign-out failed");
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
          <h2>Sign out failed</h2>
          <p className="status error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="card auth">
        <h2>Completing sign-out…</h2>
        <p className="status">Ending your Cognito session.</p>
      </section>
    </main>
  );
}
