import {
  buildRoster,
  resolveRosterViewState,
  resolveVisibleTurnState,
  rosterViewText,
  turnPresentation,
  type TurnUiStatus,
} from "../lib/workspace-state";
import {
  buildInspectorModel,
  focusRingIsVisible,
  iconOnlyControlsAreNamed,
  messagesForChannel,
  prepareOutgoingMessage,
  regionsOpenedAsSheets,
  resolveSelectionChannel,
  restoreConversation,
} from "../lib/workspace-actions";
import type { Bot, Channel, Computer, Message, Task, Turn } from "../lib/api";
import {
  buildChatticusThreadMessages,
  convertChatticusThreadMessage,
  failedTurnForConversation,
  isTurnSlow,
} from "../lib/assistant-ui-bridge";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action: string;
  bots?: Bot[];
  channels?: Channel[];
  messages?: Message[];
  tasks?: Task[];
  computer?: Computer | null;
  viewportWidthPx?: number;
  selectedId?: string;
  addressedBotId?: string;
  body?: string;
  turn?: { status: string; waiting_for: string | null } | null;
  state?: "streaming" | "waiting" | "completed" | "failed" | "reconciling" | "loading" | "empty" | "error";
  latestTurn?: Turn | null;
  activeTurn?: (Turn & { silentSeconds?: number }) | null;
};

const bots = input.bots ?? [];
const channels = input.channels ?? [];
const roster = buildRoster(bots, channels);

async function main(): Promise<void> {
let output: unknown;
if (input.action === "roster") {
  output = roster.map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    botCount: item.bots.length,
  }));
} else if (input.action === "select") {
  const item = roster.find((candidate) => candidate.id === input.selectedId);
  if (!item) {
    throw new Error(`no roster row ${input.selectedId}`);
  }
  const createdChannelIds: string[] = [];
  const channel = await resolveSelectionChannel(item, async (botId) => {
    const created = {
      channel_id: `created-${createdChannelIds.length + 1}`,
      tenant_id: "tenant-1",
      user_id: "user-1",
      kind: "direct" as const,
      name: null,
      participants: [{ kind: "bot" as const, actor_id: botId }],
    };
    createdChannelIds.push(created.channel_id);
    return created;
  });
  output = {
    channelId: channel?.channel_id ?? null,
    createdChannelIds,
    messages: messagesForChannel(
      { [channel?.channel_id ?? ""]: input.messages ?? [] },
      channel?.channel_id ?? null,
    ),
  };
} else if (input.action === "send") {
  const item = roster.find((candidate) => candidate.id === input.selectedId) ?? null;
  output = prepareOutgoingMessage(item, input.addressedBotId ?? "", input.body ?? "", {
    sending: false,
    turn: null,
  });
} else if (input.action === "reload") {
  output = restoreConversation(input.messages ?? [], input.turn ?? null);
} else if (input.action === "inspector") {
  const item = roster.find((candidate) => candidate.id === input.selectedId) ?? null;
  output = buildInspectorModel({
    computer: input.computer ?? null,
    tasks: input.tasks ?? [],
    selectedItem: item,
    bots,
  });
} else if (input.action === "accessibility") {
  output = {
    sheets: regionsOpenedAsSheets(input.viewportWidthPx ?? 1440),
    iconControlsNamed: iconOnlyControlsAreNamed(),
    focusRing: focusRingIsVisible(),
  };
} else if (input.action === "thread") {
  const activeTurn = input.activeTurn ?? null;
  const items = buildChatticusThreadMessages(
    [...(input.messages ?? [])].sort((left, right) => left.seq - right.seq),
    activeTurn,
    "",
    activeTurn ? "active" : null,
    failedTurnForConversation(input.latestTurn ?? null, input.messages ?? []),
    activeTurn ? isTurnSlow((activeTurn.silentSeconds ?? 0) * 1000) : false,
  );
  const botNameById = new Map(bots.map((bot) => [bot.bot_id, bot.name]));
  output = items.map((item) => {
    const converted = convertChatticusThreadMessage(item, botNameById);
    const custom = (converted.metadata?.custom ?? {}) as Record<string, unknown>;
    const first = Array.isArray(converted.content) ? converted.content[0] : undefined;
    return {
      role: converted.role,
      text: first && typeof first === "object" && "text" in first ? first.text : null,
      failed: Boolean(custom.failed),
      retryBody: (custom.retryBody as string | undefined) ?? null,
      authorBotName: (custom.authorBotName as string | undefined) ?? null,
    };
  });
} else if (input.action === "turn-presentation") {
  const wanted = input.state as "streaming" | "waiting" | "completed" | "failed" | "reconciling";
  const turnStatus = { streaming: "active", waiting: "active", completed: "completed", failed: "failed", reconciling: "reconciling" }[wanted] as TurnUiStatus;
  const turn = { waiting_for: wanted === "waiting" ? "computer" : null };
  const visible = resolveVisibleTurnState(turnStatus, turn, wanted === "streaming" ? "partial reply" : "");
  output = visible ? turnPresentation(visible) : null;
} else if (input.action === "roster-presentation") {
  const wanted = input.state as "loading" | "empty" | "error";
  const visible = resolveRosterViewState({
    loading: wanted === "loading",
    failed: wanted === "error",
    rosterRowCount: 0,
    visibleRowCount: 0,
    query: "",
  });
  output = visible ? rosterViewText(visible) : null;
} else {
  throw new Error(`unknown action ${input.action}`);
}

process.stdout.write(JSON.stringify(output));
}

main().catch((caught) => {
  console.error(caught);
  process.exit(1);
});
