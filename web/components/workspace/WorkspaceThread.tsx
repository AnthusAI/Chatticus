"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { BotAvatarView } from "@/components/BotAvatarView";
import type { BotAvatarState, WorkspaceMember, WorkspaceMessage, WorkspaceMessageAuthor } from "./types";

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

/** Minimum gap between two reveals that both have no typingBeforeMs of their own, so "instant" messages don't pop in on the same frame. */
const MIN_REVEAL_STAGGER_MS = 260;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveals `messages` one at a time (optionally preceded by a typing
 * indicator, per message.typingBeforeMs) instead of dumping the whole
 * array in at once, and pops in a message's `reaction` after its own
 * delay. This is real behavior of the shared thread component -- not a
 * marketing-only affordance -- so it has to behave correctly for a live
 * app too:
 *
 * - A brand-new message set (switching members, or the demo swapping to a
 *   new scripted beat) resets and replays from the start.
 * - Messages *appended* to the same set already on screen (the real app,
 *   mid-conversation) continue from wherever the reveal sequence already
 *   was instead of replaying the whole history -- a real chat should
 *   never re-animate messages the user already read.
 * - Messages with no `typingBeforeMs`/`reaction` (every real message
 *   today) reveal with just a brief stagger and no typing indicator --
 *   this hook is a no-op in spirit for the current real app, and only
 *   changes behavior once something actually sets that metadata.
 * - `prefers-reduced-motion` reveals everything immediately.
 */
function useRevealedMessages(member: WorkspaceMember | null, messages: WorkspaceMessage[]) {
  const [revealedCount, setRevealedCount] = useState(0);
  const [typingAuthor, setTypingAuthor] = useState<WorkspaceMessageAuthor | null>(null);
  const [visibleReactionIds, setVisibleReactionIds] = useState<ReadonlySet<string>>(new Set());

  const prevMemberIdRef = useRef<string | null>(null);
  const prevMessagesRef = useRef<WorkspaceMessage[]>([]);
  const revealedCountRef = useRef(0);
  revealedCountRef.current = revealedCount;

  useEffect(() => {
    const sameMember = prevMemberIdRef.current === (member?.id ?? null);
    const previous = prevMessagesRef.current;
    const isAppend =
      sameMember &&
      messages.length >= previous.length &&
      previous.every((prevMessage, index) => messages[index]?.id === prevMessage.id);

    prevMemberIdRef.current = member?.id ?? null;
    prevMessagesRef.current = messages;

    if (prefersReducedMotion()) {
      setRevealedCount(messages.length);
      setTypingAuthor(null);
      setVisibleReactionIds(new Set(messages.filter((message) => message.reaction).map((message) => message.id)));
      return undefined;
    }

    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const schedule = (delay: number, action: () => void) => {
      timeouts.push(
        setTimeout(() => {
          if (!cancelled) action();
        }, delay),
      );
    };

    const startIndex = isAppend ? Math.min(revealedCountRef.current, messages.length) : 0;
    if (!isAppend) {
      setRevealedCount(0);
      setTypingAuthor(null);
      setVisibleReactionIds(new Set());
    }

    function revealFrom(index: number) {
      if (index >= messages.length) {
        setTypingAuthor(null);
        return;
      }
      const message = messages[index];
      const delay = Math.max(message.typingBeforeMs ?? 0, index === startIndex ? 0 : MIN_REVEAL_STAGGER_MS);
      if (message.typingBeforeMs) {
        setTypingAuthor(message.author);
      }
      schedule(delay, () => {
        setTypingAuthor(null);
        setRevealedCount(index + 1);
        if (message.reaction) {
          schedule(message.reaction.delayMs, () => {
            setVisibleReactionIds((current) => new Set(current).add(message.id));
          });
        }
        revealFrom(index + 1);
      });
    }
    revealFrom(startIndex);

    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
  }, [member?.id, messages]);

  return { revealedCount, typingAuthor, visibleReactionIds };
}

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
  const { revealedCount, typingAuthor, visibleReactionIds } = useRevealedMessages(member, messages);
  const visibleMessages = messages.slice(0, revealedCount);

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
              <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[0.5rem] uppercase tracking-[0.08em] text-signal">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
                <span className="truncate">{memberActivity}</span>
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
          <div className="grid h-[15rem] content-start gap-2 overflow-y-auto">
            {visibleMessages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "animate-rise rounded-xl px-3 py-2",
                  message.author === "operator" ? "bg-surface-high" : "bg-signal text-ink",
                )}
              >
                <p className="font-mono text-[0.5rem] uppercase tracking-[0.08em] opacity-60">
                  {message.authorLabel}
                </p>
                <p className="font-body text-sm leading-relaxed">{message.body}</p>
                {message.reaction && visibleReactionIds.has(message.id) ? (
                  <span
                    className="animate-pop mt-1.5 inline-flex w-fit items-center rounded-full bg-surface px-2 py-0.5 text-sm text-surface-foreground"
                    aria-hidden="true"
                  >
                    {message.reaction.emoji}
                  </span>
                ) : null}
              </div>
            ))}
            {typingAuthor ? (
              <div
                className={cn(
                  "flex w-fit items-center gap-1 rounded-xl px-3 py-2.5",
                  typingAuthor === "operator" ? "bg-surface-high" : "bg-signal text-ink",
                )}
                aria-hidden="true"
              >
                <span className="animate-typing-bounce h-1.5 w-1.5 rounded-full bg-current [animation-delay:0ms]" />
                <span className="animate-typing-bounce h-1.5 w-1.5 rounded-full bg-current [animation-delay:150ms]" />
                <span className="animate-typing-bounce h-1.5 w-1.5 rounded-full bg-current [animation-delay:300ms]" />
              </div>
            ) : null}
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
