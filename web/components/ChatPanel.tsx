"use client";

import type { BotAvatarState } from "anthus-vultus";
import type { Bot, TurnEvent } from "../lib/api";
import { BotAvatarView } from "./BotAvatarView";

type ChatPanelProps = {
  bot: Bot | null;
  avatarState: BotAvatarState;
  avatarAriaLabel: string;
  draft: string;
  sending: boolean;
  sendError: string | null;
  turnId: string | null;
  turnStatus: "active" | "completed" | "failed" | "reconciling" | null;
  streamError: string | null;
  progress: string;
  events: TurnEvent[];
  onDraftChange: (value: string) => void;
  onSend: () => void;
};

export function ChatPanel({
  bot,
  avatarState,
  avatarAriaLabel,
  draft,
  sending,
  sendError,
  turnId,
  turnStatus,
  streamError,
  progress,
  events,
  onDraftChange,
  onSend,
}: ChatPanelProps) {
  const disabled = !bot || sending || draft.trim().length === 0;

  return (
    <section className="card chat" aria-label="Chat">
      <div className="chat-header">
        {bot ? (
          <BotAvatarView
            botName={bot.name}
            state={avatarState}
            size={72}
            ariaLabel={avatarAriaLabel}
            className="chat-avatar"
          />
        ) : null}
        <h2>{bot ? `Chat with ${bot.name}` : "Chat"}</h2>
      </div>
      {!bot ? (
        <p className="status">Select a bot from the roster to start chatting.</p>
      ) : (
        <>
          <form
            className="chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled) {
                onSend();
              }
            }}
          >
            <label className="sr-only" htmlFor="chat-message">
              Message for {bot.name}
            </label>
            <textarea
              id="chat-message"
              rows={3}
              value={draft}
              placeholder={`Message ${bot.name}…`}
              onChange={(event) => onDraftChange(event.target.value)}
              disabled={sending}
            />
            <button type="submit" disabled={disabled}>
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
          {sendError ? <p className="status error">{sendError}</p> : null}
          {turnId ? (
            <div className="turn-progress">
              <p className="status">
                Turn <code>{turnId}</code>
                {turnStatus === "completed" ? (
                  <span className="turn-badge completed">completed</span>
                ) : null}
                {turnStatus === "failed" ? (
                  <span className="turn-badge failed">failed</span>
                ) : null}
                {turnStatus === "reconciling" ? (
                  <span className="turn-badge reconciling">reconciling</span>
                ) : null}
              </p>
              {streamError ? <p className="status error">{streamError}</p> : null}
              {progress ? <p className="progress-text">{progress}</p> : null}
              {events.length > 0 ? (
                <ul className="event-log" aria-label="Turn events">
                  {events.map((event) => (
                    <li key={`${event.kind}-${event.seq}`}>
                      <span className="event-kind">{event.kind}</span>
                      {event.token ? <span>{event.token}</span> : null}
                      {event.body ? <span>{event.body}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : turnStatus === "active" ? (
                <p className="status">Waiting for turn progress…</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
