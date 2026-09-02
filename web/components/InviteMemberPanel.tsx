"use client";

import { useState } from "react";

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
    <section className="card membership">
      <h2>Invite a teammate</h2>
      <p className="status">
        Send an invitation by email. They join when they sign in with that Google
        account.
      </p>
      <form
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
        <label className="status" htmlFor="invite-email">
          Email address
        </label>
        <input
          id="invite-email"
          type="email"
          className="retry-button"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
        {error ? <p className="status error">{error}</p> : null}
        {confirmation ? <p className="status ok">{confirmation}</p> : null}
        <button type="submit" className="retry-button" disabled={submitting || !email.trim()}>
          Send invitation
        </button>
      </form>
    </section>
  );
}
