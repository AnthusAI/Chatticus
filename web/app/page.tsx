"use client";

import { useEffect, useState } from "react";

type HealthResponse = {
  environment?: string;
  status?: string;
};

export default function HomePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadHealth() {
      try {
        const response = await fetch("/api/health");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = (await response.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(body);
          setHealthError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setHealth(null);
          setHealthError(error instanceof Error ? error.message : "unknown error");
        }
      }
    }
    void loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Chatticus</h1>
      <p>Named bots, one shared computer, serverless control plane.</p>
      <section className="card">
        <h2>Control plane</h2>
        <p className="status">
          API base: <code>/api</code> (same origin)
        </p>
        {health ? (
          <p className="status ok">
            Health: {health.status ?? "ok"}
            {health.environment ? ` (${health.environment})` : ""}
          </p>
        ) : (
          <p className="status error">
            Health check pending{healthError ? `: ${healthError}` : ""}
          </p>
        )}
      </section>
    </main>
  );
}
