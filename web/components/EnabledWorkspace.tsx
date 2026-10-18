"use client";

import {
  CircleAlert,
  Menu,
  PanelRight,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ChatticusAssistantRuntime } from "./assistant-ui/ChatticusAssistantRuntime";
import { BotAvatarView } from "./BotAvatarView";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet } from "./ui/sheet";
import { ComputerPausedNotice } from "./ComputerPausedNotice";
import { ChannelCostChip, MessageCostContext, type MessageCostContextValue } from "./workspace/CostMarkers";
import { WorkspaceColumnResizeHandle, useResizableWorkspaceColumnWidth } from "./workspace/WorkspaceColumnResizeHandle";
import { useWorkspaceViewportHeight } from "./useWorkspaceViewportHeight";
import { PanelPluginTabs, PanelSizeSwitch, type PanelHostPlacement } from "./workspace/PanelPluginTabs";
import { useVoiceControl, type VoiceControl } from "./useVoiceControl";
import {
  createBot,
  createChannel,
  getActiveTurn,
  getLatestTurn,
  postVoiceMessage,
  getComputer,
  listBots,
  listChannels,
  listMessages,
  listTasks,
  postMessage,
  type Bot,
  type Channel,
  type Computer,
  type Message,
  type Task,
  type Turn,
  type TurnEvent,
} from "../lib/api";
import { avatarActivityFromTurn, botAvatarStateFromActivity } from "../lib/avatar-state";
import { costsApiFor } from "../lib/costs-api";
import { CostsController } from "../lib/costs-controller";
import { replyLatenciesBySeq } from "../lib/costs";
import { downloadTextFile } from "../lib/download-text-file";
import type { ActiveOrg } from "../lib/membership-state";
import type { MeOrganization } from "../lib/me";
import { createResumableTurnStream } from "../lib/resumable-turn-stream";
import { openTurnStream } from "../lib/sse";
import { isTerminalTurnEvent } from "../lib/sse-parse";
import { formatTime } from "../lib/time";
import {
  buildRoster,
  resolveRosterViewState,
  rosterViewText,
  getSendBlockMessage,
  getSendBlockReason,
  latestMessage,
  resolveVisibleTurnState,
  shouldClearTurnBubbleAfterTerminal,
  turnPresentation,
  type RosterItem,
  type TurnUiStatus,
} from "../lib/workspace-state";
import {
  FOCUS_RING_CLASS,
  ICON_ONLY_CONTROL_NAMES,
  INSPECTOR_DESKTOP_MIN_WIDTH_PX,
  INSPECTOR_SHEET_TITLE,
  ROSTER_DESKTOP_MIN_WIDTH_PX,
  ROSTER_SHEET_TITLE,
  buildInspectorModel,
  messagesForChannel,
  prepareOutgoingMessage,
  resolveSelectionChannel,
} from "../lib/workspace-actions";
import { isTurnGrantPanelVisible } from "../lib/turn-grant";
import {
  replyForEndedTurn,
  turnEndAnnouncement,
  voiceKeyterms,
} from "../lib/voice-control";
import { createVoiceLineDelivery } from "../lib/voice-line-delivery";
import type { RetainedTurnActivity } from "../lib/committed-activity";
import { reduceTurnActivity } from "../lib/turn-activity";
import { panelSizeForPlugin, workspaceColumnWidthStyle, workspaceShellLayoutClassName, type PanelSize } from "../lib/panel-plugins";
import type { PanelPluginObjectReference, PanelPluginStatus } from "../lib/panel-plugin-host-api";
import { panelPluginRegistry } from "../lib/panel-plugin-registry";
import { PanelPluginViewport } from "./workspace/panel-plugins/PanelPluginViewport";
import type { CorePanelServices } from "./workspace/panel-plugins/core-panel-elements";
import { configuredPanelPluginManifestUrls, useConfiguredPanelPluginManifests, useRegisteredPanelPlugins } from "./workspace/panel-plugins/use-registered-panel-plugins";
import { touchedFilesFromActivity } from "../lib/touched-files";
import { failedTurnForConversation, isTurnSlow, type FailedTurn } from "../lib/assistant-ui-bridge";
type EnabledWorkspaceProps = {
  activeOrg: ActiveOrg;
  organizations: MeOrganization[];
  sessionEmail: string | null;
  onSignOut: () => Promise<void>;
  onReloadMembership: () => Promise<void>;
};



function turnStatusFromKind(kind: string): TurnUiStatus {
  if (kind === "turn.completed") return "completed";
  if (kind === "turn.failed") return "failed";
  if (kind === "turn.reconciling") return "reconciling";
  return "active";
}

function channelIdForItem(item: RosterItem | null): string | null {
  return item?.channel?.channel_id ?? null;
}

function AvatarStack({ bots, size = 38 }: { bots: Bot[]; size?: number }) {
  return (
    <span className="flex shrink-0 -space-x-3" aria-label={`${bots.length} bot participants`}>
      {bots.slice(0, 3).map((bot) => (
        <BotAvatarView
          key={bot.bot_id}
          botName={bot.name}
          state="neutral"
          size={size}
          className="rounded-2xl"
        />
      ))}
    </span>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="m-auto max-w-md px-8 text-center">
      <h2 className="font-display text-3xl font-medium tracking-tight">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-surface-foreground/60">{body}</p>
    </div>
  );
}

const CONFIGURED_PANEL_PLUGIN_MANIFEST_URLS = configuredPanelPluginManifestUrls(process.env.NEXT_PUBLIC_PANEL_PLUGIN_MANIFEST_URLS);

function isBelowDockedPanelWidth(): boolean {
  return !window.matchMedia(`(min-width: ${INSPECTOR_DESKTOP_MIN_WIDTH_PX}px)`).matches;
}

export function EnabledWorkspace({
  activeOrg,
  organizations,
  sessionEmail,
  onSignOut,
  onReloadMembership,
}: EnabledWorkspaceProps) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, Message[]>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [addressedBotId, setAddressedBotId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [turnStatus, setTurnStatus] = useState<TurnUiStatus>(null);
  const [turnEvents, setTurnEvents] = useState<TurnEvent[]>([]);
  const turnEventsRef = useRef<TurnEvent[]>([]);
  const [retainedActivity, setRetainedActivity] = useState<RetainedTurnActivity | null>(null);
  const [progress, setProgress] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [latestEndedTurn, setLatestEndedTurn] = useState<Turn | null>(null);
  const [lastProgressAt, setLastProgressAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [rosterOpen, setRosterOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  useWorkspaceViewportHeight();
  const [rosterWidthPixels, setRosterWidthPixels] = useResizableWorkspaceColumnWidth("roster");
  const [panelWidthPixels, setPanelWidthPixels] = useResizableWorkspaceColumnWidth("panel");
  const rosterColumnRef = useRef<HTMLDivElement>(null);
  const panelColumnRef = useRef<HTMLDivElement>(null);
  useConfiguredPanelPluginManifests(CONFIGURED_PANEL_PLUGIN_MANIFEST_URLS);
  const panelPlugins = useRegisteredPanelPlugins();
  const [inspectorTab, setInspectorTab] = useState<string>("context");
  const [panelSize, setPanelSize] = useState<PanelSize>("split");
  const [visitedPanelPluginIds, setVisitedPanelPluginIds] = useState<ReadonlySet<string>>(() => new Set(["context"]));
  const [panelObjectReferenceByPluginId, setPanelObjectReferenceByPluginId] = useState<Record<string, PanelPluginObjectReference | undefined>>({});
  const [panelTitleByPluginId, setPanelTitleByPluginId] = useState<Record<string, string | undefined>>({});
  const [panelStatusByPluginId, setPanelStatusByPluginId] = useState<Record<string, PanelPluginStatus | undefined>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"bot" | "channel">("bot");
  const [createName, setCreateName] = useState("");
  const [createBotIds, setCreateBotIds] = useState<string[]>([]);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const streamGenerationRef = useRef(0);
  const selectionLoadRef = useRef(0);
  const sendingRef = useRef(false);
  const sendGenerationRef = useRef(0);
  const voiceListeningRef = useRef(false);
  const speakAloudRef = useRef<(text: string) => void>(() => undefined);
  const selectedItemIdRef = useRef<string | null>(null);
  const roster = useMemo(() => buildRoster(bots, channels), [bots, channels]);
  const botNameById = useMemo(
    () => new Map(bots.map((bot) => [bot.bot_id, bot.name])),
    [bots],
  );
  const selectedItem = roster.find((item) => item.id === selectedItemId) ?? null;
  const selectedChannelId = channelIdForItem(selectedItem);
  const selectedMessages = useMemo(
    () => messagesForChannel(messagesByChannel, selectedChannelId),
    [messagesByChannel, selectedChannelId],
  );
  const visibleRoster = roster.filter((item) =>
    item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const touchedFiles = useMemo(
    () =>
      touchedFilesFromActivity(selectedMessages, [
        ...(retainedActivity?.activity.tools ?? []),
        ...reduceTurnActivity(turnEvents).tools,
      ]),
    [selectedMessages, retainedActivity, turnEvents],
  );
  const inspector = buildInspectorModel({ computer, tasks, selectedItem, bots });
  const costs = useMemo(
    () =>
      new CostsController({
        api: costsApiFor({ tenantId: activeOrg.tenantId, userId: activeOrg.userId }),
        now: () => new Date(),
        deliverFile: downloadTextFile,
      }),
    [activeOrg.tenantId, activeOrg.userId],
  );
  const costsSnapshot = useSyncExternalStore(costs.subscribe, costs.getSnapshot, costs.getSnapshot);
  const costLabels = useMemo(() => {
    const channelLabels = new Map(
      roster.flatMap((item) => (item.channel ? [[item.channel.channel_id, item.label] as const] : [])),
    );
    return {
      botName: (botId: string) => botNameById.get(botId) ?? botId,
      channelName: (channelId: string) => channelLabels.get(channelId) ?? "Conversation",
    };
  }, [roster, botNameById]);
  useEffect(() => {
    void costs.selectChannel(selectedChannelId);
  }, [costs, selectedChannelId]);
  const turnWasActiveRef = useRef(false);
  useEffect(() => {
    if (turn) {
      turnWasActiveRef.current = true;
    } else if (turnWasActiveRef.current) {
      turnWasActiveRef.current = false;
      void costs.refreshChannel();
    }
  }, [costs, turn]);
  const showCostsTab = useCallback(() => {
    setVisitedPanelPluginIds((visited) => new Set(visited).add("costs"));
    setInspectorTab("costs");
    setInspectorOpen(isBelowDockedPanelWidth());
    setInspectorCollapsed(false);
  }, []);
  const replyLatencyMsBySeq = useMemo(
    () =>
      costsSnapshot.channel.status === "ready"
        ? replyLatenciesBySeq(costsSnapshot.channel.value.turns.rows, selectedMessages)
        : new Map<number, number>(),
    [costsSnapshot.channel, selectedMessages],
  );
  const replyLatenciesMs = useMemo(() => [...replyLatencyMsBySeq.values()], [replyLatencyMsBySeq]);
  const messageCostContext = useMemo<MessageCostContextValue>(
    () => ({
      markers: costsSnapshot.markers,
      replyLatencyMsBySeq,
      onOpen: (seq) => {
        void costs.openMessage(seq);
        showCostsTab();
      },
    }),
    [costs, costsSnapshot.markers, replyLatencyMsBySeq, showCostsTab],
  );
  const rosterViewState = resolveRosterViewState({
    loading,
    failed: Boolean(error),
    rosterRowCount: roster.length,
    visibleRowCount: visibleRoster.length,
    query,
  });
  const visibleTurnState = resolveVisibleTurnState(turnStatus, turn, progress);
  const sendBlockReason = getSendBlockReason(sending, turn, addressedBotId);
  const sendBlockMessage = getSendBlockMessage(sendBlockReason);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedBots, loadedChannels] = await Promise.all([
        listBots(activeOrg),
        listChannels(activeOrg),
      ]);
      const [loadedTasks, loadedComputer] = await Promise.all([
        listTasks(activeOrg).catch(() => []),
        getComputer(activeOrg).catch(() => null),
      ]);
      const messageResults = await Promise.allSettled(
        loadedChannels.map((channel) => listMessages(activeOrg, channel.channel_id)),
      );
      const entries = loadedChannels.map((channel, index) => {
        const result = messageResults[index];
        const messages = result.status === "fulfilled" ? result.value : [];
        return [channel.channel_id, messages] as const;
      });
      setBots(loadedBots);
      setChannels(loadedChannels);
      setTasks(loadedTasks);
      setComputer(loadedComputer);
      setMessagesByChannel(Object.fromEntries(entries));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workspace failed to load");
    } finally {
      setLoading(false);
    }
  }, [activeOrg]);

  useEffect(() => void loadWorkspace(), [loadWorkspace]);
  useEffect(
    () => () => {
      streamGenerationRef.current += 1;
      closeStreamRef.current?.();
    },
    [activeOrg.tenantId],
  );
  useEffect(() => {
    const desktopRoster = window.matchMedia(`(min-width: ${ROSTER_DESKTOP_MIN_WIDTH_PX}px)`);
    const desktopInspector = window.matchMedia(`(min-width: ${INSPECTOR_DESKTOP_MIN_WIDTH_PX}px)`);
    const closeSheetsAtDesktopWidths = () => {
      if (desktopRoster.matches) setRosterOpen(false);
      if (desktopInspector.matches) setInspectorOpen(false);
    };
    closeSheetsAtDesktopWidths();
    desktopRoster.addEventListener("change", closeSheetsAtDesktopWidths);
    desktopInspector.addEventListener("change", closeSheetsAtDesktopWidths);
    return () => {
      desktopRoster.removeEventListener("change", closeSheetsAtDesktopWidths);
      desktopInspector.removeEventListener("change", closeSheetsAtDesktopWidths);
    };
  }, []);

  const reconcileMessages = useCallback(
    async (channelId: string) => {
      const [committed, refreshedTasks, refreshedComputer] = await Promise.all([
        listMessages(activeOrg, channelId),
        listTasks(activeOrg).catch(() => tasks),
        getComputer(activeOrg).catch(() => computer),
      ]);
      return { committed, refreshedTasks, refreshedComputer };
    },
    [activeOrg, computer, tasks],
  );

  const startTurnStream = useCallback(
    (activeTurn: Turn) => {
      closeStreamRef.current?.();
      const streamGeneration = (streamGenerationRef.current += 1);
      const isCurrentStream = () => streamGeneration === streamGenerationRef.current;

      const clearStoredTurnProgress = (storageKey: string, progressStorageKey: string) => {
        window.sessionStorage.removeItem(storageKey);
        window.sessionStorage.removeItem(progressStorageKey);
      };

      const parkStreamWithoutTerminal = (message: string) => {
        if (!isCurrentStream()) {
          return;
        }
        setStreamError(message);
        setTurn(null);
        setTurnStatus(null);
        setTurnEvents([]);
        setProgress("");
      };

      const storageKey = `chatticus:last-event:${activeTurn.turn_id}`;
      const progressStorageKey = `chatticus:turn-progress:${activeTurn.turn_id}`;

      const resumableStream = createResumableTurnStream({
        onAttemptStart: (isFirstAttempt) => {
          if (!isCurrentStream()) {
            return;
          }
          setTurn(activeTurn);
          if (isFirstAttempt) {
            setTurnStatus("active");
            setTurnEvents([]);
            turnEventsRef.current = [];
            clearStoredTurnProgress(storageKey, progressStorageKey);
          }
          setStreamError(null);
          setProgress(window.sessionStorage.getItem(progressStorageKey) ?? "");
        },
        openStream: (handlers, lastEventId) =>
          openTurnStream(activeOrg.tenantId, activeTurn.turn_id, handlers, lastEventId),
        onGaveUp: parkStreamWithoutTerminal,
        onEvent: (event) => {
          if (!isCurrentStream()) {
            return;
          }
          window.sessionStorage.setItem(storageKey, String(event.seq));
          turnEventsRef.current = [...turnEventsRef.current, event];
          setTurnEvents((current) => [...current, event]);
          if (event.kind === "turn.waiting") {
            setTurn((current) =>
              current
                ? { ...current, waiting_for: event.body ?? "input" }
                : current,
            );
          }
          if (event.kind === "turn.token" && event.token) {
            setTurn((current) =>
              current ? { ...current, waiting_for: null } : current,
            );
            setProgress((current) => {
              const next = current + event.token;
              window.sessionStorage.setItem(progressStorageKey, next);
              return next;
            });
          }
          if (isTerminalTurnEvent(event.kind)) {
            setTurnStatus(turnStatusFromKind(event.kind));
            void reconcileMessages(activeTurn.channel_id).then((result) => {
              if (!isCurrentStream()) {
                return;
              }
              if (result) {
                setMessagesByChannel((current) => ({
                  ...current,
                  [activeTurn.channel_id]: result.committed,
                }));
                setTasks(result.refreshedTasks);
                setComputer(result.refreshedComputer);
                const endedReply =
                  event.kind === "turn.completed"
                    ? replyForEndedTurn(activeTurn, result.committed)
                    : null;
                if (endedReply) {
                  setRetainedActivity({
                    messageId: endedReply.message_id,
                    activity: reduceTurnActivity(turnEventsRef.current),
                  });
                }
              }
              if (shouldClearTurnBubbleAfterTerminal(event.kind)) {
                clearStoredTurnProgress(storageKey, progressStorageKey);
                setProgress("");
                setTurn(null);
                setTurnStatus(null);
                setTurnEvents([]);
              }
              const reply =
                event.kind === "turn.completed"
                  ? replyForEndedTurn(activeTurn, result?.committed ?? [])
                  : null;
              const announcement =
                event.kind === "turn.failed"
                  ? turnEndAnnouncement({
                      listening: voiceListeningRef.current,
                      outcome: { kind: "failed", reason: event.body ?? "The turn failed." },
                    })
                  : reply
                    ? turnEndAnnouncement({
                        listening: voiceListeningRef.current,
                        outcome: { kind: "completed", body: reply.body },
                      })
                    : null;
              if (announcement) {
                speakAloudRef.current(announcement);
              }
              if (event.kind === "turn.failed") {
                if (activeTurn.prompt_message_seq != null) {
                  setLatestEndedTurn({
                    ...activeTurn,
                    status: "failed",
                    terminal_reason: event.body ?? null,
                  });
                } else {
                  setStreamError(event.body ?? "Turn failed");
                }
              }
            });
          }
        },
      });

      closeStreamRef.current = resumableStream.close;
      resumableStream.start();
    },
    [activeOrg.tenantId, reconcileMessages],
  );

  const selectItem = useCallback(
    async (item: RosterItem): Promise<Channel | null> => {
      streamGenerationRef.current += 1;
      const selectionLoadToken = (selectionLoadRef.current += 1);
      setError(null);
      let channel: Channel | null = item.channel;
      if (item.kind === "bot" && !channel) {
        try {
          channel = await resolveSelectionChannel(item, (botId) => createChannel(activeOrg, [botId]));
          setChannels((current) => [...current.filter((row) => row.channel_id !== channel?.channel_id), channel!]);
          setMessagesByChannel((current) => ({ ...current, [channel!.channel_id]: [] }));
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Conversation failed to open");
          return null;
        }
      }
      setSelectedItemId(item.id);
      selectedItemIdRef.current = item.id;
      setLatestEndedTurn(null);
      setAddressedBotId(item.bots[0]?.bot_id ?? "");
      setRosterOpen(false);
      setTurn(null);
      setTurnStatus(null);
      setProgress("");
      closeStreamRef.current?.();
      if (!channel) return null;
      const openedChannel = channel;
      try {
        const [committed, activeTurn] = await Promise.all([
          listMessages(activeOrg, channel.channel_id),
          getActiveTurn(activeOrg, channel.channel_id),
        ]);
        if (selectionLoadToken !== selectionLoadRef.current) {
          return openedChannel;
        }
        setMessagesByChannel((current) => ({ ...current, [openedChannel.channel_id]: committed }));
        if (activeTurn) {
          startTurnStream(activeTurn);
        } else {
          const sendGeneration = sendGenerationRef.current;
          const latestTurn = await getLatestTurn(activeOrg, openedChannel.channel_id).catch(() => null);
          if (
            selectionLoadToken === selectionLoadRef.current &&
            sendGeneration === sendGenerationRef.current
          ) {
            setLatestEndedTurn(latestTurn);
          }
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Conversation failed to load");
      }
      return openedChannel;
    },
    [activeOrg, startTurnStream],
  );

  const deliverPost = useCallback(
    async (
      channelId: string,
      botId: string,
      send: () => Promise<{ message: Message | null; turn_id: string | null; degraded?: boolean }>,
    ): Promise<{ message: Message | null; degraded: boolean } | null> => {
      sendingRef.current = true;
      sendGenerationRef.current += 1;
      setSending(true);
      setStreamError(null);
      setLatestEndedTurn(null);
      try {
        const response = await send();
        const posted = response.message;
        const degraded = Boolean(response.degraded);
        if (!posted) {
          return { message: null, degraded };
        }
        setMessagesByChannel((current) => ({
          ...current,
          [channelId]: [...(current[channelId] ?? []), posted],
        }));
        if (response.turn_id) {
          startTurnStream({
            turn_id: response.turn_id,
            tenant_id: activeOrg.tenantId,
            channel_id: channelId,
            bot_id: botId,
            status: "active",
            waiting_for: null,
            prompt_message_seq: posted.seq,
          });
        }
        return { message: posted, degraded };
      } catch (caught) {
        setStreamError(caught instanceof Error ? caught.message : "Message failed to send");
        return null;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [activeOrg.tenantId, startTurnStream],
  );

  const postToChannel = useCallback(
    async (channelId: string, botId: string, body: string): Promise<boolean> =>
      (await deliverPost(channelId, botId, () => postMessage(activeOrg, channelId, body, botId))) !==
      null,
    [activeOrg, deliverPost],
  );

  const handleSendMessage = useCallback(
    async (body: string) => {
      const outgoing = prepareOutgoingMessage(selectedItem, addressedBotId, body, { sending, turn });
      if (!outgoing) {
        return;
      }
      await postToChannel(outgoing.channelId, outgoing.addressedToBotId, outgoing.body);
    },
    [addressedBotId, postToChannel, selectedItem, sending, turn],
  );

  const voiceKeytermList = useMemo(() => voiceKeyterms(bots), [bots]);
  const stopVoiceRef = useRef<() => Promise<void>>(async () => undefined);
  const speakingRef = useRef(false);
  const stopSpeakingRef = useRef<(reason?: string) => void>(() => undefined);

  const voiceContextRef = useRef({
    activeOrg,
    bots,
    channels,
    selectedItemId,
    addressedBotId,
    botNameById,
    deliverPost,
  });
  useEffect(() => {
    voiceContextRef.current = {
      activeOrg,
      bots,
      channels,
      selectedItemId,
      addressedBotId,
      botNameById,
      deliverPost,
    };
  }, [activeOrg, addressedBotId, bots, botNameById, channels, deliverPost, selectedItemId]);
  const voiceControlRef = useRef<Pick<VoiceControl, "speak" | "showNote"> | null>(null);

  const voiceDelivery = useMemo(
    () =>
      createVoiceLineDelivery({
        workspace: () => {
          const context = voiceContextRef.current;
          return {
            bots: context.bots,
            channels: context.channels,
            selectedId: selectedItemIdRef.current,
            addressedBotId: context.addressedBotId || null,
          };
        },
        botName: (botId) => voiceContextRef.current.botNameById.get(botId) ?? "your teammate",
        turnIsActive: async (channelId) =>
          Boolean(await getActiveTurn(voiceContextRef.current.activeOrg, channelId)),
        sendIsInFlight: () => sendingRef.current,
        sendLine: async (botId, channelId, transcript) => {
          const context = voiceContextRef.current;
          const delivered = await context.deliverPost(channelId, botId, () =>
            postVoiceMessage(context.activeOrg, channelId, transcript, botId),
          );
          if (!delivered) {
            return { kind: "failed" };
          }
          if (!delivered.message) {
            return { kind: "nothingToSend" };
          }
          return { kind: "sent", understood: delivered.message.body, degraded: delivered.degraded };
        },
        openItemId: () => selectedItemIdRef.current,
        speakFeedback: (text) => voiceControlRef.current?.speak(text),
        replyIsSpeaking: () => speakingRef.current,
        notify: (note) => voiceControlRef.current?.showNote(note),
        stopSpeaking: (reason) => stopSpeakingRef.current(reason),
        stopListening: () => stopVoiceRef.current(),
        retryLater: (action, milliseconds) => {
          window.setTimeout(action, milliseconds);
        },
        now: () => Date.now(),
      }),
    [],
  );

  const handleVoiceLine = useCallback(
    (text: string, line: { overlapsSpeech: boolean }): Promise<string> =>
      voiceDelivery.handleLine(text, line),
    [voiceDelivery],
  );

  const handleVoiceStopped = useCallback(
    () => voiceDelivery.clear("voice listening was turned off"),
    [voiceDelivery],
  );

  useEffect(() => {
    voiceDelivery.clear("you switched conversations");
  }, [selectedItemId, voiceDelivery]);

  useEffect(() => {
    if (!turn && selectedChannelId) {
      void voiceDelivery.flush(selectedChannelId, { afterTurn: true });
    }
  }, [turn, selectedChannelId, voiceDelivery]);

  useEffect(() => {
    if (!turn && !sending && selectedChannelId) {
      void voiceDelivery.flush(selectedChannelId);
    }
  }, [sending, turn, selectedChannelId, voiceDelivery]);

  const handleRetryFailedTurn = useCallback(
    async (failure: FailedTurn) => {
      if (!selectedChannelId || sendingRef.current) {
        return;
      }
      setAddressedBotId(failure.botId);
      await postToChannel(selectedChannelId, failure.botId, failure.retryBody);
    },
    [postToChannel, selectedChannelId],
  );

  const activeTurnId = turn?.turn_id ?? null;

  useEffect(() => {
    const startedAt = Date.now();
    setLastProgressAt(startedAt);
    setNow(startedAt);
  }, [activeTurnId, progress]);

  useEffect(() => {
    if (!activeTurnId) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [activeTurnId]);

  const failedTurn = useMemo(
    () => (turn ? null : failedTurnForConversation(latestEndedTurn, selectedMessages)),
    [latestEndedTurn, selectedMessages, turn],
  );

  const turnIsSlow = Boolean(turn) && !progress && isTurnSlow(now - lastProgressAt);

  const voice = useVoiceControl({
    keyterms: voiceKeytermList,
    onLine: handleVoiceLine,
    onStopped: handleVoiceStopped,
  });
  useEffect(() => {
    stopVoiceRef.current = voice.stop;
    stopSpeakingRef.current = voice.stopSpeaking;
    speakingRef.current = voice.speaking;
    voiceControlRef.current = { speak: voice.speak, showNote: voice.showNote };
  }, [voice.stop, voice.stopSpeaking, voice.speaking, voice.speak, voice.showNote]);

  useEffect(() => {
    if (!voice.speaking) {
      voiceDelivery.replyEnded();
    }
  }, [voice.speaking, voiceDelivery]);

  useEffect(() => {
    voiceListeningRef.current = voice.listening;
    speakAloudRef.current = voice.speak;
  }, [voice.listening, voice.speak]);

  async function handleCreate() {
    if (!createName.trim()) return;
    try {
      if (createMode === "bot") {
        await createBot(activeOrg, createName);
      } else {
        if (createBotIds.length < 2) {
          setError("A named channel needs at least two bots.");
          return;
        }
        await createChannel(activeOrg, createBotIds, createName);
      }
      setCreateName("");
      setCreateBotIds([]);
      setCreateOpen(false);
      await loadWorkspace();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed");
    }
  }

  const avatarActivity = avatarActivityFromTurn(turnEvents, turnStatus, sending);
  const activeAvatarState = botAvatarStateFromActivity(avatarActivity);
  const activeOrganization = organizations.find((org) => org.tenant_id === activeOrg.tenantId);

  const rosterPane = (
    <aside className="flex h-full min-h-0 flex-col bg-surface-raised p-3 sm:p-4" aria-label={ROSTER_SHEET_TITLE}>
      <div className="flex items-center justify-between px-2 py-2">
        <div>
          <p className="text-base font-extrabold tracking-tight">chatticus<span className="text-clay">.</span></p>
          <p className="font-mono text-[0.65rem] text-surface-foreground/50">{activeOrganization?.name ?? "Workspace"}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={ICON_ONLY_CONTROL_NAMES.addBotOrChannel} onClick={() => setCreateOpen((open) => !open)}>
          <Plus size={19} aria-hidden="true" />
        </Button>
      </div>
      {createOpen ? (
        <form
          className="mb-3 rounded-2xl bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-raised p-1">
            <button type="button" className={`rounded-lg px-2 py-2 text-xs font-bold ${createMode === "bot" ? "bg-surface" : ""}`} onClick={() => setCreateMode("bot")}>Bot</button>
            <button type="button" className={`rounded-lg px-2 py-2 text-xs font-bold ${createMode === "channel" ? "bg-surface" : ""}`} onClick={() => setCreateMode("channel")}>Channel</button>
          </div>
          <Input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={createMode === "bot" ? "Bot name" : "Channel name"} className="h-10 rounded-xl bg-surface-raised px-3" />
          {createMode === "channel" ? (
            <div className="mt-2 grid gap-1">
              {bots.map((bot) => (
                <label key={bot.bot_id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-surface-raised">
                  <input type="checkbox" checked={createBotIds.includes(bot.bot_id)} onChange={() => setCreateBotIds((current) => current.includes(bot.bot_id) ? current.filter((id) => id !== bot.bot_id) : [...current, bot.bot_id])} />
                  {bot.name}
                </label>
              ))}
            </div>
          ) : null}
          <Button type="submit" className="mt-3 w-full shadow-none" size="sm">{createMode === "bot" ? "Create bot" : "Create channel"}</Button>
        </form>
      ) : null}
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-foreground/45" size={17} aria-hidden="true" />
        <span className="sr-only">Search bots and channels</span>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="h-11 rounded-xl bg-surface pl-10 pr-3" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rosterViewState ? <p className="px-3 py-8 text-sm text-surface-foreground/55">{rosterViewText(rosterViewState)}</p> : null}
        <ul className="grid gap-1">
          {visibleRoster.map((item) => {
            const latest = item.channel ? latestMessage(messagesByChannel[item.channel.channel_id] ?? []) : null;
            const selected = item.id === selectedItemId;
            return (
              <li key={item.id}>
                <button type="button" className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${FOCUS_RING_CLASS} ${selected ? "bg-surface-high" : "hover:bg-surface/70"}`} onClick={() => void selectItem(item)}>
                  {item.kind === "bot" ? <BotAvatarView botName={item.bot.name} state={selected ? activeAvatarState : "neutral"} size={42} /> : <AvatarStack bots={item.bots} size={38} />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <strong className="truncate text-sm font-bold">{item.label}</strong>
                      <span className="shrink-0 font-mono text-[0.6rem] text-surface-foreground/45">{formatTime(latest?.created_at)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-surface-foreground/55">{latest?.body ?? (item.kind === "channel" ? `${item.bots.length} bots` : "Start a conversation")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-2xl bg-surface px-3 py-2">
        <span className="min-w-0 truncate text-xs font-semibold">{sessionEmail ?? "Account"}</span>
        <button className={`rounded-lg px-2 py-1 text-xs text-surface-foreground/60 hover:bg-surface-raised ${FOCUS_RING_CLASS}`} onClick={() => void onSignOut()}>Sign out</button>
      </div>
    </aside>
  );

  const selectPanelPlugin = useCallback((pluginId: string) => {
    setVisitedPanelPluginIds((visited) => (visited.has(pluginId) ? visited : new Set(visited).add(pluginId)));
    setInspectorTab(pluginId);
    setPanelSize((currentSize) => panelSizeForPlugin(pluginId, currentSize, panelPlugins));
  }, [panelPlugins]);

  const openPanelObject = useCallback((objectReference: PanelPluginObjectReference) => {
    const handler = panelPluginRegistry.findHandlerOfObjectType(objectReference.type);
    if (!handler) return;
    setPanelObjectReferenceByPluginId((references) => ({ ...references, [handler.id]: objectReference }));
    selectPanelPlugin(handler.id);
    setInspectorOpen(isBelowDockedPanelWidth());
    setInspectorCollapsed(false);
  }, [selectPanelPlugin]);

  const setPanelPluginTitle = useCallback((pluginId: string, title: string) => {
    setPanelTitleByPluginId((titles) => ({ ...titles, [pluginId]: title }));
  }, []);

  const setPanelPluginStatus = useCallback((pluginId: string, status: PanelPluginStatus | null) => {
    setPanelStatusByPluginId((statuses) => ({ ...statuses, [pluginId]: status ?? undefined }));
  }, []);

  const corePanelServices = useMemo<CorePanelServices>(
    () => ({
      activeOrg,
      role: activeOrganization?.role ?? "member",
      touchedFiles,
      costs,
      costLabels,
      inspector,
      tasksAreOrganizationWide: selectedItem?.kind === "channel",
      turnGrantTurnId: turn && isTurnGrantPanelVisible(turn.turn_id, turnStatus) ? turn.turn_id : null,
    }),
    [activeOrg, activeOrganization?.role, touchedFiles, costs, costLabels, inspector, selectedItem?.kind, turn, turnStatus],
  );

  const renderPanelHost = (placement: PanelHostPlacement) => (
    <aside className="flex h-full min-h-0 flex-col bg-surface-raised p-3" aria-label={INSPECTOR_SHEET_TITLE}>
      <div className="flex items-center gap-2 pb-3">
        <h2 className="sr-only">{panelTitleByPluginId[inspectorTab] ?? panelPlugins.find((plugin) => plugin.id === inspectorTab)?.name}</h2>
        <PanelPluginTabs
          placement={placement}
          plugins={panelPlugins}
          selected={inspectorTab}
          titleByPluginId={panelTitleByPluginId}
          statusByPluginId={panelStatusByPluginId}
          onSelect={selectPanelPlugin}
        />
        <span className="flex-1" />
        <div className="hidden xl:block">
          <PanelSizeSwitch size={panelSize} onChange={(size) => setPanelSize(panelSizeForPlugin(inspectorTab, size, panelPlugins))} />
        </div>
        <Button variant="ghost" size="icon" aria-label={ICON_ONLY_CONTROL_NAMES.closeInspector} onClick={() => { setInspectorOpen(false); setInspectorCollapsed(true); setPanelSize("split"); }}><X size={18} aria-hidden="true" /></Button>
      </div>
      <PanelPluginViewport
        placement={placement}
        plugins={panelPlugins}
        selectedPluginId={inspectorTab}
        visitedPluginIds={visitedPanelPluginIds}
        size={panelSize}
        organizationKey={activeOrg.tenantId}
        services={corePanelServices}
        objectReferenceByPluginId={panelObjectReferenceByPluginId}
        onOpenObject={openPanelObject}
        onTitleChange={setPanelPluginTitle}
        onStatusChange={setPanelPluginStatus}
      />
    </aside>
  );

  const panelFillsWorkspace = !inspectorCollapsed && panelSize === "full";

  return (
    <main
      id="main-content"
      className={`${workspaceShellLayoutClassName({ collapsed: inspectorCollapsed, size: panelSize, rosterResized: rosterWidthPixels !== null, panelResized: panelWidthPixels !== null })} min-h-0 bg-surface text-surface-foreground`}
      style={workspaceColumnWidthStyle({ rosterWidthPixels, panelWidthPixels })}
    >
      <div ref={rosterColumnRef} className="workspace-roster hidden min-h-0 md:block">
        {rosterPane}
        <WorkspaceColumnResizeHandle
          column="roster"
          label="Resize sidebar"
          measureRenderedColumnWidthPixels={() => rosterColumnRef.current?.getBoundingClientRect().width ?? 0}
          onWidthChange={setRosterWidthPixels}
        />
      </div>
      <section className="flex min-h-0 min-w-0 flex-col bg-surface" aria-label="Conversation">
        <header className="flex min-h-16 items-center gap-2 px-3 py-2 sm:px-5">
          <Button variant="ghost" size="icon" className={panelFillsWorkspace ? "md:hidden xl:inline-flex" : "md:hidden"} aria-label={ICON_ONLY_CONTROL_NAMES.openRoster} onClick={() => setRosterOpen(true)}><Menu size={19} aria-hidden="true" /></Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-extrabold">{selectedItem?.label ?? "Conversations"}</h1>
            {selectedItem ? <p className="truncate font-mono text-[0.62rem] text-surface-foreground/45">{selectedItem.kind === "channel" ? `${selectedItem.bots.length} bot channel` : "Direct conversation"}</p> : null}
            {visibleTurnState ? <p className="mt-0.5 inline-flex rounded-full bg-surface-raised px-2 py-0.5 font-mono text-[0.62rem] text-surface-foreground/70" aria-live="polite">{turnPresentation(visibleTurnState)}</p> : null}
          </div>
          <ChannelCostChip
            phase={costsSnapshot.channel}
            replyLatenciesMs={replyLatenciesMs}
            onOpen={() => {
              costs.setScope("channel");
              costs.closeDrilldown();
              showCostsTab();
            }}
          />
          <Button variant="ghost" size="icon" aria-label={ICON_ONLY_CONTROL_NAMES.openInspector} onClick={() => { setInspectorOpen(isBelowDockedPanelWidth()); setInspectorCollapsed(false); }}><PanelRight size={19} aria-hidden="true" /></Button>
        </header>
        <ComputerPausedNotice organization={activeOrganization} activeOrg={activeOrg} onCeilingRaised={onReloadMembership} />
        {error ? (
          <div role="alert" className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-clay/15 px-3 py-2 text-xs">
            <CircleAlert size={16} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" className={`shrink-0 rounded-lg p-1 hover:bg-clay/10 ${FOCUS_RING_CLASS}`} aria-label={ICON_ONLY_CONTROL_NAMES.dismissError} onClick={() => setError(null)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {!selectedItem ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 sm:px-5">
            <EmptyState
              title="Choose a teammate"
              body="Open a bot or named channel from the roster to continue its durable conversation."
            />
          </div>
        ) : (
          <MessageCostContext.Provider value={messageCostContext}>
          <ChatticusAssistantRuntime
            className="min-h-0 flex-1"
            messages={selectedMessages}
            turn={turn}
            progress={progress}
            turnStatus={turnStatus}
            isSendDisabled={sendBlockReason !== null}
            botNameById={botNameById}
            onSendMessage={handleSendMessage}
            failedTurn={failedTurn}
            turnIsSlow={turnIsSlow}
            turnEvents={turnEvents}
            retainedActivity={retainedActivity}
            onRetryFailedTurn={handleRetryFailedTurn}
            threadProps={{
              composerPlaceholder: `Message ${selectedItem.label}`,
              streamError,
              onDismissStreamError: () => setStreamError(null),
              sendBlockMessage,
              composerActions: voice.composerAction,
              composerStatus: voice.composerStatus,
              emptyState: (
                <EmptyState
                  title={`Start with ${selectedItem.label}`}
                  body={
                    selectedItem.kind === "channel"
                      ? "Choose which participating bot should answer, then send the first message."
                      : "This is the bot’s one ongoing conversation with you."
                  }
                />
              ),
              composerAccessory:
                selectedItem.kind === "channel"
                  ? (
                    <label className="mb-2 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-xs font-semibold">
                      <span className="text-surface-foreground/55">To</span>
                      <select
                        className="bg-transparent font-semibold outline-none"
                        value={addressedBotId}
                        onChange={(event) => setAddressedBotId(event.target.value)}
                        aria-label="Teammate to address"
                      >
                        {selectedItem.bots.map((bot) => (
                          <option key={bot.bot_id} value={bot.bot_id}>{bot.name}</option>
                        ))}
                      </select>
                    </label>
                  )
                  : undefined,
            }}
          />
          </MessageCostContext.Provider>
        )}
      </section>
      {!inspectorCollapsed ? (
        <div ref={panelColumnRef} className="workspace-panel hidden min-h-0 xl:block">
          <WorkspaceColumnResizeHandle
            column="panel"
            label="Resize panel"
            measureRenderedColumnWidthPixels={() => panelColumnRef.current?.getBoundingClientRect().width ?? 0}
            onWidthChange={setPanelWidthPixels}
          />
          {renderPanelHost("docked")}
        </div>
      ) : null}

      <div className="md:hidden">
        <Sheet open={rosterOpen} onOpenChange={setRosterOpen} title={ROSTER_SHEET_TITLE} side="left">
          {rosterPane}
        </Sheet>
      </div>
      <div className="xl:hidden">
        <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen} title={INSPECTOR_SHEET_TITLE}>
          {renderPanelHost("sheet")}
        </Sheet>
      </div>
    </main>
  );
}
