"use client";

import { useState } from "react";

import {
  AuthCard,
  authButtonClassName,
  authErrorClassName,
  authFieldClassName,
  authOkClassName,
  authStatusClassName,
} from "./AuthCard";
import {
  buildTurnGrantPayload,
  CONVERSATION_PRESET_TOOLS,
  DEFAULT_TURN_GRANT_FORM,
  TURN_GRANT_FORM_TITLE,
  turnGrantConfirmationText,
  type TurnGrantFormState,
} from "../lib/turn-grant";
import { replaceTurnGrant } from "../lib/api";
import type { ActiveOrg } from "../lib/membership-state";

type TurnGrantPanelProps = {
  activeOrg: ActiveOrg;
  turnId: string;
};

export function TurnGrantPanel({ activeOrg, turnId }: TurnGrantPanelProps) {
  const [form, setForm] = useState<TurnGrantFormState>(DEFAULT_TURN_GRANT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  function updateForm(patch: Partial<TurnGrantFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  return (
    <AuthCard title={TURN_GRANT_FORM_TITLE}>
      <p className={authStatusClassName}>
        Replace the entire closed grant for this active turn. Conversation preset:{" "}
        {CONVERSATION_PRESET_TOOLS.join(", ")}. Submit sends a full replace, not a merge.
      </p>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const payload = buildTurnGrantPayload(form);
          if (!payload || submitting) {
            return;
          }
          setSubmitting(true);
          setError(null);
          setConfirmation(null);
          void replaceTurnGrant(activeOrg, turnId, payload)
            .then((response) => {
              setConfirmation(turnGrantConfirmationText(response.tools));
            })
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : "grant replace failed");
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <fieldset className="grid gap-1.5">
          <legend className="sr-only">Granted tools</legend>
          <label className="flex items-center gap-2 font-body text-sm">
            <input
              type="checkbox"
              checked={form.browse}
              onChange={(event) => updateForm({ browse: event.target.checked })}
              disabled={submitting}
            />
            browse
          </label>
          <label className="flex items-center gap-2 font-body text-sm">
            <input
              type="checkbox"
              checked={form.readWorkspace}
              onChange={(event) => updateForm({ readWorkspace: event.target.checked })}
              disabled={submitting}
            />
            read_workspace
          </label>
          <label className="flex items-center gap-2 font-body text-sm">
            <input
              type="checkbox"
              checked={form.writeWorkspace}
              onChange={(event) => updateForm({ writeWorkspace: event.target.checked })}
              disabled={submitting}
            />
            write_workspace
          </label>
          <label className="flex items-center gap-2 font-body text-sm">
            <input
              type="checkbox"
              checked={form.runTerminal}
              onChange={(event) => updateForm({ runTerminal: event.target.checked })}
              disabled={submitting}
            />
            run_terminal (explicit shell access)
          </label>
        </fieldset>

        {form.browse ? (
          <>
            <label className="sr-only" htmlFor="turn-grant-origins">
              Browse origins
            </label>
            <input
              id="turn-grant-origins"
              type="text"
              className={authFieldClassName}
              value={form.origins}
              placeholder="https://docs.example.com"
              onChange={(event) => updateForm({ origins: event.target.value })}
              disabled={submitting}
              autoComplete="off"
            />
          </>
        ) : null}

        <label className="sr-only" htmlFor="turn-grant-file-scopes">
          File scopes
        </label>
        <input
          id="turn-grant-file-scopes"
          type="text"
          className={authFieldClassName}
          value={form.fileScopes}
          placeholder="/workspace"
          onChange={(event) => updateForm({ fileScopes: event.target.value })}
          disabled={submitting}
          autoComplete="off"
        />

        {error ? <p className={authErrorClassName}>{error}</p> : null}
        {confirmation ? <p className={authOkClassName}>{confirmation}</p> : null}
        <button
          type="submit"
          className={authButtonClassName}
          disabled={
            submitting ||
            !buildTurnGrantPayload(form) ||
            (form.browse && form.origins.trim().length === 0)
          }
        >
          Replace turn grant
        </button>
      </form>
    </AuthCard>
  );
}
