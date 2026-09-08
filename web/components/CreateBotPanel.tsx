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
import { CREATE_BOT_FORM_TITLE, createBotConfirmationText } from "../lib/create-bot";
import { createBot } from "../lib/api";
import type { ActiveOrg } from "../lib/membership-state";

type CreateBotPanelProps = {
  activeOrg: ActiveOrg;
  onCreated: () => Promise<void>;
};

export function CreateBotPanel({ activeOrg, onCreated }: CreateBotPanelProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  return (
    <AuthCard title={CREATE_BOT_FORM_TITLE}>
      <p className={authStatusClassName}>
        Name a bot teammate for this organization. The roster refreshes after creation.
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
          setConfirmation(null);
          void createBot(activeOrg, trimmed)
            .then(async (bot) => {
              setConfirmation(createBotConfirmationText(bot.name));
              setName("");
              await onCreated();
            })
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : "create bot failed");
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <label className="sr-only" htmlFor="create-bot-name">
          Bot name
        </label>
        <input
          id="create-bot-name"
          type="text"
          className={authFieldClassName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
          autoComplete="off"
        />
        {error ? <p className={authErrorClassName}>{error}</p> : null}
        {confirmation ? <p className={authOkClassName}>{confirmation}</p> : null}
        <button type="submit" className={authButtonClassName} disabled={submitting || !name.trim()}>
          Create bot
        </button>
      </form>
    </AuthCard>
  );
}
