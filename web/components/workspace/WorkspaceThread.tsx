"use client";

import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { BotAvatarView } from "@/components/BotAvatarView";
import type { BotAvatarState, WorkspaceMember, WorkspaceMessage } from "./types";

type WorkspaceThreadProps = {
  member: WorkspaceMember | null;
  memberState: BotAvatarState;
  memberActivity?: string;
  messages: WorkspaceMessage[];
  draft: string;
  sending: boolean;
  sendError?: string | null;
  disabled?: boolean;
  composerPlaceholder?: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
};

export function WorkspaceThread({
  member,
  memberState,
  memberActivity,
  messages,
  draft,
  sending,
  sendError,
  disabled,
  composerPlaceholder,
  onDraftChange,
  onSend,
}: WorkspaceThreadProps) {
  const composerDisabled = disabled || !member || sending || draft.trim().length === 0;

  return (
    <section className="rounded-2xl bg-surface-raised p-3" aria-label="Conversation">
      {member ? (
        <div className="flex items-center gap-2 pb-2">
          <BotAvatarView botName={member.name} role={member.role} state={memberState} size={40} />
          <div className="min-w-0">
            {member.meta ? (
              <p className="truncate font-mono text-[0.49rem] uppercase tracking-[0.13em] text-surface-foreground/60">
                {member.meta}
              </p>
            ) : null}
            <p className="truncate font-body text-sm font-extrabold">{member.name}</p>
            {memberActivity ? (
              <p className="mt-0.5 flex items-center gap-1 font-mono text-[0.5rem] uppercase tracking-[0.08em] text-signal">
                <span className="h-1.5 w-1.5 rounded-full bg-signal" />
                {memberActivity}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="px-1 py-2 font-mono text-[0.65rem] text-surface-foreground/60">
          Select a teammate to start the conversation.
        </p>
      )}

      {member ? (
        <>
          <div className="grid gap-2">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-xl px-3 py-2",
                  message.author === "operator" ? "bg-surface-high" : "bg-signal text-ink",
                )}
              >
                <p className="font-mono text-[0.5rem] uppercase tracking-[0.08em] opacity-60">
                  {message.authorLabel}
                </p>
                <p className="font-body text-sm leading-relaxed">{message.body}</p>
              </div>
            ))}
          </div>

          <form
            className="mt-2 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!composerDisabled) {
                onSend();
              }
            }}
          >
            <label className="sr-only" htmlFor="workspace-thread-message">
              Message for {member.name}
            </label>
            <textarea
              id="workspace-thread-message"
              rows={2}
              value={draft}
              placeholder={composerPlaceholder ?? `Message ${member.name}…`}
              onChange={(event) => onDraftChange(event.target.value)}
              disabled={disabled || sending}
              className="w-full resize-none rounded-xl bg-surface px-3 py-2 font-body text-sm text-surface-foreground placeholder:text-surface-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            />
            <button
              type="submit"
              disabled={composerDisabled}
              className="flex min-h-9 w-fit items-center justify-self-end gap-1.5 rounded-[18px_18px_4px_18px] bg-ink px-3 font-body text-xs font-bold text-paper transition disabled:opacity-40"
            >
              {sending ? "Sending…" : "Send"}
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {sendError ? <p className="font-mono text-[0.6rem] text-clay">{sendError}</p> : null}
          </form>
        </>
      ) : null}
    </section>
  );
}
