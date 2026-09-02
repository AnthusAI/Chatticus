"use client";

import { useState } from "react";

import { createOrganization } from "../lib/organizations";
import { useMembership } from "../lib/membership-context";

export function CreateOrganizationPanel() {
  const { refreshMe } = useMembership();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card membership">
      <h2>Create your organization</h2>
      <p className="status">
        Name the organization you want to use on Chatticus. An operator enables it
        before the workspace unlocks.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed || submitting) {
            return;
          }
          setSubmitting(true);
          setError(null);
          void createOrganization(trimmed)
            .then(() => refreshMe())
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : "create failed");
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <label className="status" htmlFor="organization-name">
          Organization name
        </label>
        <input
          id="organization-name"
          className="retry-button"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
        />
        {error ? <p className="status error">{error}</p> : null}
        <button type="submit" className="retry-button" disabled={submitting || !name.trim()}>
          Create organization
        </button>
      </form>
    </section>
  );
}
