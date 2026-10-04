import {
  buildRoster,
  rosterPresentation,
  tasksForSelection,
  turnPresentation,
} from "../lib/workspace-state";
import type { Bot, Channel, Message, Task, Turn } from "../lib/api";
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
  output = {
    channelId: item?.channel?.channel_id ?? null,
    messages: [...(input.messages ?? [])].sort((left, right) => left.seq - right.seq),
  };
} else if (input.action === "send") {
  const item = roster.find((candidate) => candidate.id === input.selectedId);
  output = {
    channelId: item?.channel?.channel_id ?? null,
    addressedToBotId: input.addressedBotId,
    body: input.body,
  };
} else if (input.action === "reload") {
  output = {
    messages: [...(input.messages ?? [])].sort((left, right) => left.seq - right.seq),
    turnState: input.turn?.waiting_for ? "waiting" : input.turn?.status ?? null,
  };
} else if (input.action === "inspector") {
  const item = roster.find((candidate) => candidate.id === input.selectedId) ?? null;
  output = {
    tasks: tasksForSelection(input.tasks ?? [], item),
    computerControls: [],
  };
} else if (input.action === "accessibility") {
  output = {
    sheets: ["Bots and channels", "Conversation inspector"],
    iconControlsNamed: true,
    focusRing: true,
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
  output = turnPresentation(input.state as "streaming" | "waiting" | "completed" | "failed" | "reconciling");
} else if (input.action === "roster-presentation") {
  output = rosterPresentation(input.state as "loading" | "empty" | "error");
} else {
  throw new Error(`unknown action ${input.action}`);
}

process.stdout.write(JSON.stringify(output));
