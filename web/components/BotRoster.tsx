"use client";

import type { BotAvatarState } from "anthus-vultus";
import type { Bot } from "../lib/api";
import { botRoleLabel, creativeRoleForBot } from "../lib/bot-role";
import { BotAvatarView } from "./BotAvatarView";

type BotRosterProps = {
  bots: Bot[];
  selectedBotId: string | null;
  selectedBotAvatarState: BotAvatarState;
  loading: boolean;
  error: string | null;
  onSelect: (bot: Bot) => void;
  onRetry?: () => void;
};

export function BotRoster({
  bots,
  selectedBotId,
  selectedBotAvatarState,
  loading,
  error,
  onSelect,
  onRetry,
}: BotRosterProps) {
  return (
    <section className="roster panel" aria-label="Teammate roster">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Your organization</p>
          <h2>Teammates</h2>
        </div>
        <span className="count-badge">{bots.length}</span>
      </div>
      {loading ? <p className="status">Loading roster…</p> : null}
      {error ? (
        <div className="status-block">
          <p className="status error">{error}</p>
          {onRetry ? (
            <button type="button" className="retry-button" onClick={onRetry}>
              Retry roster
            </button>
          ) : null}
        </div>
      ) : null}
      {!loading && !error && bots.length === 0 ? (
        <p className="status">No teammates yet. Create one through the control plane.</p>
      ) : null}
      <ul className="bot-list">
        {bots.map((bot) => (
          <li key={bot.bot_id}>
            <button
              type="button"
              className={selectedBotId === bot.bot_id ? "bot selected" : "bot"}
              onClick={() => onSelect(bot)}
            >
              <BotAvatarView
                botName={bot.name}
                state={
                  selectedBotId === bot.bot_id
                    ? selectedBotAvatarState
                    : "neutral"
                }
                size={40}
                className="bot-avatar"
                modelRole={creativeRoleForBot(bot)}
              />
              <span className="bot-copy">
                <span className="bot-name">{bot.name}</span>
                <span className="bot-role">{botRoleLabel(bot)}</span>
                <span className="bot-meta">
                  {Object.keys(bot.memory).length > 0
                    ? `${Object.keys(bot.memory).length} memories`
                    : "Ready"}
                </span>
              </span>
              <span className="bot-arrow" aria-hidden="true">&#8599;</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
