"use client";

import type { BotAvatarState } from "anthus-vultus";
import type { AvatarActivity } from "../lib/avatar-state";
import type { Bot, TurnEvent } from "../lib/api";
import { botRoleLabel, creativeRoleForBot } from "../lib/bot-role";
import { BotAvatarView } from "./BotAvatarView";

type ChatPanelProps = {
  bot: Bot | null;
  avatarState: BotAvatarState;
  avatarAriaLabel: string;
  avatarActivity: AvatarActivity;
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
  avatarActivity,
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
    <section className="chat panel" aria-label="Chat">
      <div className="chat-header">
        {bot ? (
          <BotAvatarView
            botName={bot.name}
            state={avatarState}
            size={72}
            ariaLabel={avatarAriaLabel}
            className="chat-avatar"
            modelRole={creativeRoleForBot(bot)}
          />
        ) : null}
        <div className="chat-heading-copy">
          <p className="eyebrow">Shared room</p>
          <h2>{bot ? bot.name : "Choose a teammate"}</h2>
          {bot ? <p className="chat-role">{botRoleLabel(bot)}</p> : null}
          {bot ? (
            <p className="activity-label" aria-live="polite">
              <span className={`activity-dot ${avatarActivity}`} />
              {avatarActivity === "idle" ? "Ready" : avatarActivity}
            </p>
          ) : null}
        </div>
      </div>
      {!bot ? (
        <div className="empty-room">
          <p className="empty-room-kicker">The room is quiet.</p>
          <p>Select a named teammate to start a channel and put work in motion.</p>
        </div>
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
              {sending ? "Handing off…" : "Hand off"}
            </button>
          </form>
          {sendError ? <p className="status error">{sendError}</p> : null}
          {turnId ? (
            <div className="turn-progress" aria-live="polite">
              <div className="turn-heading">
                <p className="eyebrow">Work in motion</p>
                {turnStatus === "completed" ? (
                  <span className="turn-badge completed">completed</span>
                ) : null}
                {turnStatus === "failed" ? (
                  <span className="turn-badge failed">failed</span>
                ) : null}
                {turnStatus === "reconciling" ? (
                  <span className="turn-badge reconciling">reconciling</span>
                ) : null}
              </div>
              {streamError ? <p className="status error">{streamError}</p> : null}
              {progress ? <p className="progress-text">{progress}</p> : null}
              {events.length > 0 ? (
                <details className="diagnostics">
                  <summary>Turn details</summary>
                  <p className="diagnostic-id">{turnId}</p>
                  <ul className="event-log" aria-label="Turn events">
                    {events.map((event) => (
                      <li key={`${event.kind}-${event.seq}`}>
                        <span className="event-kind">{event.kind}</span>
                        {event.token ? <span>{event.token}</span> : null}
                        {event.body ? <span>{event.body}</span> : null}
                      </li>
                    ))}
                  </ul>
                </details>
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
