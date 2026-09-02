"use client";

import { useState } from "react";

import { AuthCard, authButtonClassName, authErrorClassName, authFieldClassName, authOkClassName, authStatusClassName } from "./AuthCard";
import { inviteConfirmationText, inviteMember } from "../lib/invitations";

type InviteMemberPanelProps = {
  tenantId: string;
};

export function InviteMemberPanel({ tenantId }: InviteMemberPanelProps) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  return (
    <AuthCard title="Invite a teammate">
      <p className={authStatusClassName}>
        Send an invitation by email. They join when they sign in with that Google
        account.
      </p>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = email.trim();
          if (!trimmed || submitting) {
            return;
          }
          setSubmitting(true);
          setError(null);
          setConfirmation(null);
          void inviteMember(tenantId, trimmed)
            .then((invitation) => {
              setConfirmation(inviteConfirmationText(invitation.email));
              setEmail("");
            })
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : "invite failed");
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <label className="sr-only" htmlFor="invite-email">
          Email address
        </label>
        <input
          id="invite-email"
          type="email"
          className={authFieldClassName}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
        {error ? <p className={authErrorClassName}>{error}</p> : null}
        {confirmation ? <p className={authOkClassName}>{confirmation}</p> : null}
        <button type="submit" className={authButtonClassName} disabled={submitting || !email.trim()}>
          Send invitation
        </button>
      </form>
    </AuthCard>
  );
}
