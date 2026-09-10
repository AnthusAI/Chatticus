"use client";

import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Computer as ComputerIcon,
  Menu,
  PanelRight,
  Plus,
  Search,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BotAvatarView } from "./BotAvatarView";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet } from "./ui/sheet";
import {
  createBot,
  createChannel,
  getActiveTurn,
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
import type { ActiveOrg } from "../lib/membership-state";
import type { MeOrganization } from "../lib/me";
import { openTurnStream } from "../lib/sse";
import { isTerminalTurnEvent } from "../lib/sse-parse";
import {
  buildRoster,
  latestMessage,
  tasksForSelection,
  turnPresentation,
  type RosterItem,
} from "../lib/workspace-state";
type EnabledWorkspaceProps = {
  activeOrg: ActiveOrg;
  organizations: MeOrganization[];
  sessionEmail: string | null;
  onSignOut: () => Promise<void>;
};
type TurnUiStatus = "active" | "completed" | "failed" | "reconciling" | null;

function formatTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

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

export function EnabledWorkspace({
  activeOrg,
  organizations,
  sessionEmail,
  onSignOut,
}: EnabledWorkspaceProps) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, Message[]>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [addressedBotId, setAddressedBotId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [turnStatus, setTurnStatus] = useState<TurnUiStatus>(null);
  const [turnEvents, setTurnEvents] = useState<TurnEvent[]>([]);
  const [progress, setProgress] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"bot" | "channel">("bot");
  const [createName, setCreateName] = useState("");
  const [createBotIds, setCreateBotIds] = useState<string[]>([]);
  const closeStreamRef = useRef<(() => void) | null>(null);

  const roster = useMemo(() => buildRoster(bots, channels), [bots, channels]);
  const selectedItem = roster.find((item) => item.id === selectedItemId) ?? null;
  const selectedChannelId = channelIdForItem(selectedItem);
  const selectedMessages = selectedChannelId ? messagesByChannel[selectedChannelId] ?? [] : [];
  const visibleRoster = roster.filter((item) =>
    item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const visibleTasks = tasksForSelection(tasks, selectedItem);
  const visibleTurnState =
    turnStatus === "failed"
      ? "failed"
      : turnStatus === "reconciling"
        ? "reconciling"
        : turnStatus === "completed"
          ? "completed"
          : turn?.waiting_for
            ? "waiting"
            : turn && progress
              ? "streaming"
              : null;

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
      const entries = await Promise.all(
        loadedChannels.map(async (channel) => [channel.channel_id, await listMessages(activeOrg, channel.channel_id)] as const),
      );
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
  useEffect(() => () => closeStreamRef.current?.(), []);
  useEffect(() => {
    const desktopRoster = window.matchMedia("(min-width: 768px)");
    const desktopInspector = window.matchMedia("(min-width: 1280px)");
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
      setMessagesByChannel((current) => ({ ...current, [channelId]: committed }));
      setTasks(refreshedTasks);
      setComputer(refreshedComputer);
    },
    [activeOrg, computer, tasks],
  );

  const startTurnStream = useCallback(
    (activeTurn: Turn) => {
      closeStreamRef.current?.();
      setTurn(activeTurn);
      setTurnStatus("active");
      setTurnEvents([]);
      setProgress("");
      setStreamError(null);
      const storageKey = `chatticus:last-event:${activeTurn.turn_id}`;
      const lastEventId = Number(window.sessionStorage.getItem(storageKey) ?? 0);
      closeStreamRef.current = openTurnStream(
        activeOrg.tenantId,
        activeTurn.turn_id,
        {
          onEvent: (event) => {
            window.sessionStorage.setItem(storageKey, String(event.seq));
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
              setProgress((current) => current + event.token);
            }
            if (isTerminalTurnEvent(event.kind)) {
              setTurnStatus(turnStatusFromKind(event.kind));
              void reconcileMessages(activeTurn.channel_id).then(() => {
                if (event.kind === "turn.completed") setTurn(null);
              });
            }
          },
          onError: (caught) => setStreamError(caught.message),
        },
        lastEventId,
      );
    },
    [activeOrg.tenantId, reconcileMessages],
  );

  const selectItem = useCallback(
    async (item: RosterItem) => {
      setError(null);
      let channel = item.channel;
      if (item.kind === "bot" && !channel) {
        try {
          channel = await createChannel(activeOrg, [item.bot.bot_id]);
          setChannels((current) => [...current.filter((row) => row.channel_id !== channel?.channel_id), channel!]);
          setMessagesByChannel((current) => ({ ...current, [channel!.channel_id]: [] }));
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Conversation failed to open");
          return;
        }
      }
      setSelectedItemId(item.id);
      setAddressedBotId(item.bots[0]?.bot_id ?? "");
      setRosterOpen(false);
      setTurn(null);
      setTurnStatus(null);
      setProgress("");
      closeStreamRef.current?.();
      if (!channel) return;
      try {
        const [committed, activeTurn] = await Promise.all([
          listMessages(activeOrg, channel.channel_id),
          getActiveTurn(activeOrg, channel.channel_id),
        ]);
        setMessagesByChannel((current) => ({ ...current, [channel!.channel_id]: committed }));
        if (activeTurn) startTurnStream(activeTurn);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Conversation failed to load");
      }
    },
    [activeOrg, startTurnStream],
  );

  async function handleSend() {
    if (!selectedItem || !selectedChannelId || !addressedBotId || sending || !draft.trim()) return;
    setSending(true);
    setStreamError(null);
    try {
      const response = await postMessage(activeOrg, selectedChannelId, draft.trim(), addressedBotId);
      setMessagesByChannel((current) => ({
        ...current,
        [selectedChannelId]: [...(current[selectedChannelId] ?? []), response.message],
      }));
      setDraft("");
      if (response.turn_id) {
        startTurnStream({
          turn_id: response.turn_id,
          tenant_id: activeOrg.tenantId,
          channel_id: selectedChannelId,
          bot_id: addressedBotId,
          status: "active",
          waiting_for: null,
        });
      }
    } catch (caught) {
      setStreamError(caught instanceof Error ? caught.message : "Message failed to send");
    } finally {
      setSending(false);
    }
  }

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
    <aside className="flex h-full min-h-0 flex-col bg-surface-raised p-3 sm:p-4" aria-label="Bots and channels">
      <div className="flex items-center justify-between px-2 py-2">
        <div>
          <p className="text-base font-extrabold tracking-tight">chatticus<span className="text-clay">.</span></p>
          <p className="font-mono text-[0.65rem] text-surface-foreground/50">{activeOrganization?.name ?? "Workspace"}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Add bot or channel" onClick={() => setCreateOpen((open) => !open)}>
          <Plus size={19} aria-hidden="true" />
        </Button>
      </div>
      {createOpen ? (
        <div className="mb-3 rounded-2xl bg-surface p-3">
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-raised p-1">
            <button className={`rounded-lg px-2 py-2 text-xs font-bold ${createMode === "bot" ? "bg-surface" : ""}`} onClick={() => setCreateMode("bot")}>Bot</button>
            <button className={`rounded-lg px-2 py-2 text-xs font-bold ${createMode === "channel" ? "bg-surface" : ""}`} onClick={() => setCreateMode("channel")}>Channel</button>
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
          <Button className="mt-3 w-full shadow-none" size="sm" onClick={() => void handleCreate()}>{createMode === "bot" ? "Create bot" : "Create channel"}</Button>
        </div>
      ) : null}
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-foreground/45" size={17} aria-hidden="true" />
        <span className="sr-only">Search bots and channels</span>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="h-11 rounded-xl bg-surface pl-10 pr-3" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? <p className="px-3 py-8 text-sm text-surface-foreground/55">Loading conversations…</p> : null}
        {!loading && error && roster.length === 0 ? <p className="px-3 py-8 text-sm text-surface-foreground/55">Roster failed to load.</p> : null}
        {!loading && !error && visibleRoster.length === 0 ? <p className="px-3 py-8 text-sm text-surface-foreground/55">{query.trim() ? "No matching bots or channels." : "No bots or channels."}</p> : null}
        <ul className="grid gap-1">
          {visibleRoster.map((item) => {
            const latest = item.channel ? latestMessage(messagesByChannel[item.channel.channel_id] ?? []) : null;
            const selected = item.id === selectedItemId;
            return (
              <li key={item.id}>
                <button type="button" className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25 ${selected ? "bg-surface-high" : "hover:bg-surface/70"}`} onClick={() => void selectItem(item)}>
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
        <button className="rounded-lg px-2 py-1 text-xs text-surface-foreground/60 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25" onClick={() => void onSignOut()}>Sign out</button>
      </div>
    </aside>
  );

  const inspectorPane = (
    <aside className="flex h-full min-h-0 flex-col bg-surface-raised p-4" aria-label="Conversation inspector">
      <div className="flex items-center justify-between py-2">
        <h2 className="text-sm font-extrabold">Context</h2>
        <Button variant="ghost" size="icon" aria-label="Close inspector" onClick={() => { setInspectorOpen(false); setInspectorCollapsed(true); }}><X size={18} aria-hidden="true" /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
        <section className="rounded-2xl bg-surface p-4">
          <div className="flex items-center gap-2"><ComputerIcon size={17} aria-hidden="true" /><h3 className="text-sm font-bold">Computer</h3></div>
          {computer ? (
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="text-surface-foreground/50">State</dt><dd className="font-semibold">{computer.stopped ? "Stopped" : "Running"}</dd>
              <dt className="text-surface-foreground/50">Policy</dt><dd className="font-mono">{computer.policy}</dd>
              <dt className="text-surface-foreground/50">Generation</dt><dd className="font-mono">{computer.host_start_generation}</dd>
              <dt className="text-surface-foreground/50">Identity</dt><dd className="truncate font-mono" title={computer.computer_id}>{computer.computer_id}</dd>
            </dl>
          ) : <p className="mt-3 text-xs text-surface-foreground/55">Computer status unavailable.</p>}
        </section>
        <section>
          <div className="flex items-center gap-2 px-1"><Check size={17} aria-hidden="true" /><h3 className="text-sm font-bold">{selectedItem?.kind === "channel" ? "Organization tasks" : "Tasks"}</h3></div>
          {selectedItem?.kind === "channel" ? <p className="px-1 pt-1 text-xs text-surface-foreground/50">Tasks are organization-wide and are not linked to channels.</p> : null}
          <div className="mt-3 grid gap-2">
            {visibleTasks.map((task) => {
              const creator = bots.find((bot) => bot.bot_id === task.created_by_bot_id)?.name;
              const updater = bots.find((bot) => bot.bot_id === task.updated_by_bot_id)?.name;
              return (
                <details key={task.task_id} className="group rounded-2xl bg-surface p-4">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-3 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25">
                    <span className="text-sm font-semibold leading-5">{task.title}</span>
                    <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6rem] uppercase text-surface-foreground/50">{task.status}<ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" /></span>
                  </summary>
                  <dl className="mt-3 grid gap-2 text-xs text-surface-foreground/65">
                    {task.evidence ? <div><dt className="font-semibold text-surface-foreground">Evidence</dt><dd className="mt-0.5 whitespace-pre-wrap">{task.evidence}</dd></div> : null}
                    {task.close_reason ? <div><dt className="font-semibold text-surface-foreground">Close reason</dt><dd className="mt-0.5">{task.close_reason}</dd></div> : null}
                    {creator || updater ? <div><dt className="font-semibold text-surface-foreground">Bot provenance</dt><dd className="mt-0.5">{creator ? `Created by ${creator}` : ""}{creator && updater ? "; " : ""}{updater ? `updated by ${updater}` : ""}</dd></div> : null}
                  </dl>
                </details>
              );
            })}
            {visibleTasks.length === 0 ? <p className="rounded-2xl bg-surface p-4 text-xs text-surface-foreground/55">No matching tasks.</p> : null}
          </div>
        </section>
      </div>
    </aside>
  );

  return (
    <main id="main-content" className={`workspace-shell h-[100dvh] min-h-0 bg-surface text-surface-foreground ${inspectorCollapsed ? "workspace-shell--collapsed" : ""}`}>
      <div className="workspace-roster hidden min-h-0 md:block">{rosterPane}</div>
      <section className="flex min-h-0 min-w-0 flex-col bg-surface" aria-label="Conversation">
        <header className="flex min-h-16 items-center gap-2 px-3 py-2 sm:px-5">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open bots and channels" onClick={() => setRosterOpen(true)}><Menu size={19} aria-hidden="true" /></Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-extrabold">{selectedItem?.label ?? "Conversations"}</h1>
            {selectedItem ? <p className="truncate font-mono text-[0.62rem] text-surface-foreground/45">{selectedItem.kind === "channel" ? `${selectedItem.bots.length} bot channel` : "Direct conversation"}</p> : null}
            {visibleTurnState ? <p className="font-mono text-[0.62rem] text-surface-foreground/55" aria-live="polite">{turnPresentation(visibleTurnState)}</p> : null}
          </div>
          <Button variant="ghost" size="icon" aria-label="Open conversation inspector" onClick={() => { setInspectorOpen(true); setInspectorCollapsed(false); }}><PanelRight size={19} aria-hidden="true" /></Button>
        </header>
        {error ? <div role="alert" className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-clay/15 px-3 py-2 text-xs"><CircleAlert size={16} aria-hidden="true" />{error}</div> : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 sm:px-5">
          {!selectedItem ? <EmptyState title="Choose a teammate" body="Open a bot or named channel from the roster to continue its durable conversation." /> : null}
          {selectedItem && selectedMessages.length === 0 && !turn ? <EmptyState title={`Start with ${selectedItem.label}`} body={selectedItem.kind === "channel" ? "Choose which participating bot should answer, then send the first message." : "This is the bot’s one ongoing conversation with you."} /> : null}
          {selectedItem && selectedMessages.length > 0 ? (
            <ol className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-5">
              {selectedMessages.map((message) => {
                const authorBot = bots.find((bot) => bot.bot_id === message.author_id);
                return (
                  <li key={message.message_id} className={`flex ${message.author_kind === "human" ? "justify-end" : "justify-start"}`}>
                    <article className="max-w-[86%] rounded-3xl bg-surface-raised px-4 py-3 text-sm leading-6 sm:max-w-[76%]">
                      {message.author_kind === "bot" ? <p className="mb-1 text-xs font-bold">{authorBot?.name ?? "Bot"}</p> : null}
                      <p className="whitespace-pre-wrap">{message.body}</p>
                      <time className="mt-1 block font-mono text-[0.58rem] text-surface-foreground/40">{formatTime(message.created_at)}</time>
                    </article>
                  </li>
                );
              })}
              {turn ? (
                <li className="flex justify-start">
                  <article className="max-w-[86%] rounded-3xl bg-surface-raised px-4 py-3 text-sm leading-6 sm:max-w-[76%]">
                    <p className="mb-1 text-xs font-bold">{bots.find((bot) => bot.bot_id === turn.bot_id)?.name ?? "Bot"}</p>
                    {progress ? <p className="whitespace-pre-wrap">{progress}</p> : <p className="flex items-center gap-2 text-surface-foreground/55"><Clock3 size={15} aria-hidden="true" />{turn.waiting_for ? `Waiting for ${turn.waiting_for}` : turnStatus === "reconciling" ? "Reconciling committed messages…" : turnStatus === "failed" ? "Turn failed" : "Working…"}</p>}
                  </article>
                </li>
              ) : null}
            </ol>
          ) : null}
        </div>
        {selectedItem ? (
          <div className="p-3 pt-0 sm:p-5 sm:pt-0">
            <form className="mx-auto max-w-3xl rounded-3xl bg-surface-raised p-2" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
              {selectedItem.kind === "channel" ? (
                <label className="mb-1 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-xs font-semibold">
                  <span className="text-surface-foreground/55">To</span>
                  <select className="bg-transparent font-semibold outline-none" value={addressedBotId} onChange={(event) => setAddressedBotId(event.target.value)} aria-label="Teammate to address">
                    {selectedItem.bots.map((bot) => <option key={bot.bot_id} value={bot.bot_id}>{bot.name}</option>)}
                  </select>
                </label>
              ) : null}
              <div className="flex items-end gap-2">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleSend(); } }} rows={1} placeholder={`Message ${selectedItem.label}`} className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm outline-none placeholder:text-surface-foreground/40 focus-visible:ring-0" />
                <Button type="submit" size="icon" className="shrink-0 shadow-none" disabled={!draft.trim() || sending} aria-label="Send message"><Send size={17} aria-hidden="true" /></Button>
              </div>
              {streamError ? <p role="alert" className="px-3 pb-2 text-xs text-clay">{streamError}</p> : null}
            </form>
          </div>
        ) : null}
      </section>
      {!inspectorCollapsed ? <div className="workspace-inspector hidden min-h-0 xl:block">{inspectorPane}</div> : null}

      <div className="md:hidden">
        <Sheet open={rosterOpen} onOpenChange={setRosterOpen} title="Bots and channels" side="left">
          {rosterPane}
        </Sheet>
      </div>
      <div className="xl:hidden">
        <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen} title="Conversation inspector">
          {inspectorPane}
        </Sheet>
      </div>
    </main>
  );
}
