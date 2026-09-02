"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { WorkspacePanel } from "./workspace/WorkspacePanel";
import type { WorkspaceMember, WorkspaceMessage } from "./workspace/types";
import { InviteMemberPanel } from "./InviteMemberPanel";
import { TaskList } from "./TaskList";
import { avatarActivityFromTurn, botAvatarStateFromActivity } from "../lib/avatar-state";
import {
  createChannel,
  fetchHealth,
  listBots,
  postMessage,
  type Bot,
  type HealthResponse,
  type TurnEvent,
} from "../lib/api";
import type { ActiveOrg } from "../lib/membership-state";
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

type EnabledWorkspaceProps = {
  activeOrg: ActiveOrg;
};

export function EnabledWorkspace({ activeOrg }: EnabledWorkspaceProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsLoading, setBotsLoading] = useState(true);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [sentBody, setSentBody] = useState<string | null>(null);
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
      const roster = await listBots(activeOrg);
      setBots(roster);
      setBotsError(null);
    } catch (error) {
      setBots([]);
      setBotsError(error instanceof Error ? error.message : "unknown error");
    } finally {
      setBotsLoading(false);
    }
  }, [activeOrg]);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  const ensureChannel = useCallback(
    async (bot: Bot): Promise<string> => {
      if (channelId) {
        return channelId;
      }
      const channel = await createChannel(activeOrg, [bot.bot_id]);
      setChannelId(channel.channel_id);
      return channel.channel_id;
    },
    [activeOrg, channelId],
  );

  const startTurnStream = useCallback(
    (activeTurnId: string) => {
      closeStreamRef.current?.();
      setStreamError(null);
      setProgress("");
      setEvents([]);
      setTurnStatus("active");
      closeStreamRef.current = openTurnStream(
        activeOrg.tenantId,
        activeTurnId,
        {
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
        },
      );
    },
    [activeOrg.tenantId],
  );

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
    setSentBody(null);
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
        activeOrg,
        activeChannelId,
        body,
        selectedBot.bot_id,
      );
      setDraft("");
      setSentBody(body);
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

  const messages: WorkspaceMessage[] = [];
  if (sentBody) {
    messages.push({ id: "operator", author: "operator", authorLabel: "You", body: sentBody });
  }
  if (progress) {
    messages.push({
      id: "bot-response",
      author: "bot",
      authorLabel: selectedBot?.name ?? "Bot",
      body: progress,
    });
  } else if (turnId && turnStatus === "active") {
    messages.push({
      id: "bot-response",
      author: "bot",
      authorLabel: selectedBot?.name ?? "Bot",
      body: "…",
    });
  }

  const memberActivity =
    turnStatus === "failed"
      ? "Turn failed"
      : turnStatus === "reconciling"
        ? "Reconciling"
        : avatarActivity === "thinking"
          ? "Thinking…"
          : avatarActivity === "waiting"
            ? "Waiting…"
            : avatarActivity === "speaking"
              ? "Responding…"
              : avatarActivity === "completed"
                ? "Done"
                : undefined;

  const members: WorkspaceMember[] = bots.map((bot) => ({
    id: bot.bot_id,
    name: bot.name,
    meta: Object.keys(bot.memory).length > 0 ? `${Object.keys(bot.memory).length} memory keys` : undefined,
  }));

  return (
    <>
      <section className="card health">
        <h2>Control plane</h2>
        <p className="status">
          Organization: <code>{activeOrg.tenantId}</code>
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

      <InviteMemberPanel tenantId={activeOrg.tenantId} />

      <WorkspacePanel
        orgLabel={`Organization: ${activeOrg.tenantId}`}
        workspaceLabel="Workspace"
        members={members}
        selectedMemberId={selectedBot?.bot_id ?? null}
        selectedMemberState={avatarState}
        selectedMemberActivity={memberActivity}
        messages={messages}
        draft={draft}
        sending={sending}
        sendError={sendError ?? streamError}
        rosterLoading={botsLoading}
        rosterError={botsError}
        onSelectMember={(member) => {
          const bot = bots.find((candidate) => candidate.bot_id === member.id);
          if (bot) {
            void handleSelectBot(bot);
          }
        }}
        onRetryRoster={() => {
          void loadBots();
        }}
        onDraftChange={setDraft}
        onSend={() => {
          void handleSend();
        }}
      />

      <section className="card">
        <TaskList activeOrg={activeOrg} />
      </section>
    </>
  );
}
