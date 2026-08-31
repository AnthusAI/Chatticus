"use client";

import type { Bot } from "../lib/api";

type BotRosterProps = {
  bots: Bot[];
  selectedBotId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (bot: Bot) => void;
};

export function BotRoster({
  bots,
  selectedBotId,
  loading,
  error,
  onSelect,
}: BotRosterProps) {
  return (
    <section className="card roster" aria-label="Bot roster">
      <h2>Bots</h2>
      {loading ? <p className="status">Loading roster…</p> : null}
      {error ? <p className="status error">{error}</p> : null}
      {!loading && !error && bots.length === 0 ? (
        <p className="status">No bots yet. Create one through the control plane.</p>
      ) : null}
      <ul className="bot-list">
        {bots.map((bot) => (
          <li key={bot.bot_id}>
            <button
              type="button"
              className={selectedBotId === bot.bot_id ? "bot selected" : "bot"}
              onClick={() => onSelect(bot)}
            >
              <span className="bot-name">{bot.name}</span>
              {Object.keys(bot.memory).length > 0 ? (
                <span className="bot-meta">
                  {Object.keys(bot.memory).length} memory keys
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
