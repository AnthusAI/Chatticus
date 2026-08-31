"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BotRoster } from "../components/BotRoster";
import { ChatPanel } from "../components/ChatPanel";
import {
  avatarActivityFromTurn,
  botAvatarAriaLabel,
  botAvatarStateFromActivity,
} from "../lib/avatar-state";
import {
  createChannel,
  fetchHealth,
  listBots,
  postMessage,
  type Bot,
  type HealthResponse,
  type TurnEvent,
} from "../lib/api";
import { userId } from "../lib/config";
import { openTurnStream } from "../lib/sse";
import { isTerminalTurnEvent } from "../lib/sse-parse";

type TurnUiStatus = "active" | "completed" | "failed" | "reconciling" | null;

function turnStatusFromKind(kind: string): TurnUiStatus {
  if (kind === "turn.completed") {
    return "completed";
  }
  if (kind === "turn.failed") {
    return "failed";
  }
  if (kind === "turn.reconciling") {
    return "reconciling";
  }
  return "active";
}

export default function HomePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsLoading, setBotsLoading] = useState(true);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [turnStatus, setTurnStatus] = useState<TurnUiStatus>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [events, setEvents] = useState<TurnEvent[]>([]);
  const closeStreamRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadHealth() {
      try {
        const body = await fetchHealth();
        if (!cancelled) {
          setHealth(body);
          setHealthError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setHealth(null);
          setHealthError(error instanceof Error ? error.message : "unknown error");
        }
      }
    }
    void loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadBots = useCallback(async () => {
    setBotsLoading(true);
    try {
      const roster = await listBots(userId);
      setBots(roster);
      setBotsError(null);
    } catch (error) {
      setBots([]);
      setBotsError(error instanceof Error ? error.message : "unknown error");
    } finally {
      setBotsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  const ensureChannel = useCallback(async (bot: Bot): Promise<string> => {
    if (channelId) {
      return channelId;
    }
    const channel = await createChannel(userId, [bot.bot_id]);
    setChannelId(channel.channel_id);
    return channel.channel_id;
  }, [channelId]);

  const startTurnStream = useCallback((activeTurnId: string) => {
    closeStreamRef.current?.();
    setStreamError(null);
    setProgress("");
    setEvents([]);
    setTurnStatus("active");
    closeStreamRef.current = openTurnStream(activeTurnId, {
      onEvent: (event) => {
        setEvents((current) => [...current, event]);
        if (event.kind === "turn.token" && event.token) {
          setProgress((current) => current + event.token);
        }
        if (isTerminalTurnEvent(event.kind)) {
          setTurnStatus(turnStatusFromKind(event.kind));
        }
      },
      onError: (error) => {
        setStreamError(error.message);
      },
    });
  }, []);

  useEffect(() => {
    return () => {
      closeStreamRef.current?.();
    };
  }, []);

  async function handleSelectBot(bot: Bot) {
    setSelectedBot(bot);
    setSendError(null);
    setTurnId(null);
    setTurnStatus(null);
    setProgress("");
    setEvents([]);
    closeStreamRef.current?.();
    setChannelId(null);
  }

  async function handleSend() {
    if (!selectedBot || sending) {
      return;
    }
    const body = draft.trim();
    if (!body) {
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const activeChannelId = await ensureChannel(selectedBot);
      const response = await postMessage(
        activeChannelId,
        userId,
        body,
        selectedBot.bot_id,
      );
      setDraft("");
      if (response.turn_id) {
        setTurnId(response.turn_id);
        startTurnStream(response.turn_id);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "send failed");
    } finally {
      setSending(false);
    }
  }

  const avatarActivity = avatarActivityFromTurn(events, turnStatus, sending);
  const avatarState = botAvatarStateFromActivity(avatarActivity);
  const avatarAriaLabel = selectedBot
    ? botAvatarAriaLabel(selectedBot.name, avatarActivity)
    : "Bot avatar";

  return (
    <main>
      <header className="site-header">
        <h1>Chatticus</h1>
        <p>Named bots, one shared computer, serverless control plane.</p>
      </header>

      <section className="card health">
        <h2>Control plane</h2>
        <p className="status">
          API base: <code>/api</code> (same origin)
        </p>
        {health ? (
          <p className="status ok">
            Health: {health.status ?? "ok"}
            {health.environment ? ` (${health.environment})` : ""}
          </p>
        ) : (
          <p className="status error">
            Health check pending{healthError ? `: ${healthError}` : ""}
          </p>
        )}
      </section>

      <div className="workspace">
        <BotRoster
          bots={bots}
          selectedBotId={selectedBot?.bot_id ?? null}
          selectedBotAvatarState={avatarState}
          loading={botsLoading}
          error={botsError}
          onRetry={() => {
            void loadBots();
          }}
          onSelect={(bot) => {
            void handleSelectBot(bot);
          }}
        />
        <ChatPanel
          bot={selectedBot}
          avatarState={avatarState}
          avatarAriaLabel={avatarAriaLabel}
          draft={draft}
          sending={sending}
          sendError={sendError}
          turnId={turnId}
          turnStatus={turnStatus}
          streamError={streamError}
          progress={progress}
          events={events}
          onDraftChange={setDraft}
          onSend={() => {
            void handleSend();
          }}
        />
      </div>
    </main>
  );
}
