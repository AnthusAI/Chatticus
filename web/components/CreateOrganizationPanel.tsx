"use client";

import { useState } from "react";

import { AuthCard, authButtonClassName, authErrorClassName, authFieldClassName, authStatusClassName } from "./AuthCard";
import { createOrganization } from "../lib/organizations";
import { useMembership } from "../lib/membership-context";

export function CreateOrganizationPanel() {
  const { refreshMe } = useMembership();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AuthCard title="Create your organization">
      <p className={authStatusClassName}>
        Name the organization you want to use on Chatticus. An operator enables it
        before the workspace unlocks.
      </p>
      <form
        className="grid gap-2"
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
        <label className="sr-only" htmlFor="organization-name">
          Organization name
        </label>
        <input
          id="organization-name"
          className={authFieldClassName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
        />
        {error ? <p className={authErrorClassName}>{error}</p> : null}
        <button type="submit" className={authButtonClassName} disabled={submitting || !name.trim()}>
          Create organization
        </button>
      </form>
    </AuthCard>
  );
}
