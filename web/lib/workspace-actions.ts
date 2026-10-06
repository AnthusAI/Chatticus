import type { Bot, Channel, Computer, Message, Task } from "./api";
import {
  getSendBlockReason,
  resolveVisibleTurnState,
  tasksForSelection,
  type RosterItem,
  type VisibleTurnState,
} from "./workspace-state";

export const ROSTER_SHEET_TITLE = "Bots and channels";
export const INSPECTOR_SHEET_TITLE = "Conversation inspector";
export const ROSTER_DESKTOP_MIN_WIDTH_PX = 768;
export const INSPECTOR_DESKTOP_MIN_WIDTH_PX = 1280;

export const ICON_ONLY_CONTROL_NAMES = {
  addBotOrChannel: "Add bot or channel",
  openRoster: "Open bots and channels",
  openInspector: "Open conversation inspector",
  closeInspector: "Close inspector",
  dismissError: "Dismiss error",
} as const;

export const FOCUS_RING_CLASS =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25";

/**
 * Orders committed messages by their sequence so a conversation reads in the order it was committed.
 *
 * @param messages - Committed messages in any order
 * @returns A new array ordered by ascending sequence
 */
export function orderedMessages(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => left.seq - right.seq);
}

/**
 * The committed messages the workspace shows for one channel.
 *
 * @param messagesByChannel - Committed messages keyed by channel identifier
 * @param channelId - The selected channel, or null when nothing is selected
 * @returns The channel's messages in sequence order, or an empty list
 */
export function messagesForChannel(
  messagesByChannel: Record<string, Message[]>,
  channelId: string | null,
): Message[] {
  return channelId ? orderedMessages(messagesByChannel[channelId] ?? []) : [];
}

/**
 * The channel a roster row opens. A bot row reuses its one direct channel and only creates one when none exists.
 *
 * @param item - The selected roster row
 * @param createDirectChannel - Creates a direct channel with one bot
 * @returns The channel to open, or null when the row has none
 */
export async function resolveSelectionChannel(
  item: RosterItem,
  createDirectChannel: (botId: string) => Promise<Channel>,
): Promise<Channel | null> {
  if (item.channel) {
    return item.channel;
  }
  if (item.kind === "bot") {
    return createDirectChannel(item.bot.bot_id);
  }
  return null;
}

export type OutgoingMessage = {
  channelId: string;
  addressedToBotId: string;
  body: string;
};

/**
 * Builds the message the composer posts: it stays in the selected channel and is addressed to one bot.
 *
 * @param item - The selected roster row
 * @param addressedBotId - The bot the member addressed
 * @param body - The message text
 * @param state - Whether a send is running and which turn is active
 * @returns The message to post, or null when sending is blocked or nothing is selected
 */
export function prepareOutgoingMessage(
  item: RosterItem | null,
  addressedBotId: string,
  body: string,
  state: { sending: boolean; turn: unknown | null },
): OutgoingMessage | null {
  const channelId = item?.channel?.channel_id ?? null;
  if (!item || !channelId || getSendBlockReason(state.sending, state.turn, addressedBotId) !== null) {
    return null;
  }
  return { channelId, addressedToBotId: addressedBotId, body };
}

/**
 * What a reloaded conversation shows: committed messages in sequence and the visible state of any active turn.
 *
 * @param messages - Committed messages as loaded
 * @param activeTurn - The active turn the server reports, or null
 * @returns The ordered messages and the visible turn state
 */
export function restoreConversation(
  messages: Message[],
  activeTurn: { waiting_for: string | null } | null,
): { messages: Message[]; turnState: VisibleTurnState } {
  return {
    messages: orderedMessages(messages),
    turnState: resolveVisibleTurnState(activeTurn ? "active" : null, activeTurn, ""),
  };
}

export type ComputerInspectorView = {
  stateLabel: "Stopped" | "Running";
  policy: string;
  generation: number;
  identity: string;
};

export type InspectorTaskView = {
  task: Task;
  creatorName: string | undefined;
  updaterName: string | undefined;
};

export type InspectorModel = {
  computer: ComputerInspectorView | null;
  tasks: InspectorTaskView[];
  computerControls: string[];
};

/**
 * The inspector's content from real computer and task context only. The computer section is read-only, so it
 * offers no controls.
 *
 * @param inputs - The organization computer, all tasks, the selected roster row and the bots
 * @returns The computer facts, the tasks visible for the selection with bot provenance, and the computer controls
 */
export function buildInspectorModel(inputs: {
  computer: Computer | null;
  tasks: Task[];
  selectedItem: RosterItem | null;
  bots: Bot[];
}): InspectorModel {
  const nameOf = (botId: string | null) => inputs.bots.find((bot) => bot.bot_id === botId)?.name;
  return {
    computer: inputs.computer
      ? {
          stateLabel: inputs.computer.stopped ? "Stopped" : "Running",
          policy: inputs.computer.policy,
          generation: inputs.computer.host_start_generation,
          identity: inputs.computer.computer_id,
        }
      : null,
    tasks: tasksForSelection(inputs.tasks, inputs.selectedItem).map((task) => ({
      task,
      creatorName: nameOf(task.created_by_bot_id),
      updaterName: nameOf(task.updated_by_bot_id),
    })),
    computerControls: [],
  };
}

/**
 * The regions that open as named sheets rather than as fixed panes at a viewport width.
 *
 * @param viewportWidthPx - The viewport width in CSS pixels
 * @returns The sheet titles for the regions that do not fit beside the conversation
 */
export function regionsOpenedAsSheets(viewportWidthPx: number): string[] {
  const sheets: string[] = [];
  if (viewportWidthPx < ROSTER_DESKTOP_MIN_WIDTH_PX) {
    sheets.push(ROSTER_SHEET_TITLE);
  }
  if (viewportWidthPx < INSPECTOR_DESKTOP_MIN_WIDTH_PX) {
    sheets.push(INSPECTOR_SHEET_TITLE);
  }
  return sheets;
}

export function iconOnlyControlsAreNamed(): boolean {
  return Object.values(ICON_ONLY_CONTROL_NAMES).every((name) => name.trim().length > 0);
}

export function focusRingIsVisible(): boolean {
  return FOCUS_RING_CLASS.includes("focus-visible:ring-") && !FOCUS_RING_CLASS.includes("ring-0");
}
