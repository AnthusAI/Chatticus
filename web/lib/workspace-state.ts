import type { Bot, Channel, Message, Task } from "./api";

export type RosterItem =
  | { kind: "bot"; id: string; label: string; bot: Bot; channel: Channel | null; bots: Bot[] }
  | { kind: "channel"; id: string; label: string; channel: Channel; bots: Bot[] };

export function channelBotIds(channel: Channel): string[] {
  return channel.participants
    .filter((participant) => participant.kind === "bot")
    .map((participant) => participant.actor_id);
}

export function directChannelForBot(channels: Channel[], botId: string): Channel | null {
  return (
    channels.find(
      (channel) => channel.kind === "direct" && channelBotIds(channel)[0] === botId,
    ) ?? null
  );
}

export function buildRoster(bots: Bot[], channels: Channel[]): RosterItem[] {
  const botById = new Map(bots.map((bot) => [bot.bot_id, bot]));
  const botRows: RosterItem[] = bots.map((bot) => ({
    kind: "bot",
    id: `bot:${bot.bot_id}`,
    label: bot.name,
    bot,
    channel: directChannelForBot(channels, bot.bot_id),
    bots: [bot],
  }));
  const channelRows: RosterItem[] = channels
    .filter((channel) => channel.kind === "named")
    .map((channel) => ({
      kind: "channel",
      id: `channel:${channel.channel_id}`,
      label: channel.name ?? "Named channel",
      channel,
      bots: channelBotIds(channel)
        .map((botId) => botById.get(botId))
        .filter((bot): bot is Bot => Boolean(bot)),
    }));
  return [...botRows, ...channelRows];
}

export function latestMessage(messages: Message[]): Message | null {
  return messages.reduce<Message | null>(
    (latest, message) => (!latest || message.seq > latest.seq ? message : latest),
    null,
  );
}

export function tasksForSelection(tasks: Task[], item: RosterItem | null): Task[] {
  if (!item || item.kind === "channel") {
    return tasks;
  }
  return tasks.filter(
    (task) =>
      task.created_by_bot_id === item.bot.bot_id || task.updated_by_bot_id === item.bot.bot_id,
  );
}

export type TurnUiStatus = "active" | "completed" | "failed" | "reconciling" | null;

export type VisibleTurnState =
  | "streaming"
  | "waiting"
  | "completed"
  | "failed"
  | "reconciling"
  | null;

export function resolveVisibleTurnState(
  turnStatus: TurnUiStatus,
  turn: { waiting_for: string | null } | null,
  progress: string,
): VisibleTurnState {
  if (turnStatus === "failed") {
    return "failed";
  }
  if (turnStatus === "reconciling") {
    return "reconciling";
  }
  if (turnStatus === "completed") {
    return turn !== null ? "completed" : null;
  }
  if (turn?.waiting_for) {
    return "waiting";
  }
  if (turn && progress) {
    return "streaming";
  }
  return null;
}

export function isComposerSendBlocked(sending: boolean, turn: unknown | null): boolean {
  return sending || turn !== null;
}

export const TRANSCRIPT_STICK_THRESHOLD_PX = 100;

export function transcriptDistanceFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return scrollHeight - scrollTop - clientHeight;
}

export function shouldStickTranscriptScroll(
  channelChanged: boolean,
  distanceFromBottomPx: number,
  thresholdPx: number = TRANSCRIPT_STICK_THRESHOLD_PX,
): boolean {
  if (channelChanged) {
    return true;
  }
  return distanceFromBottomPx <= thresholdPx;
}

export function shouldClearTurnBubbleAfterTerminal(kind: string): boolean {
  return kind === "turn.completed" || kind === "turn.failed";
}

export function turnPresentation(
  state: "streaming" | "waiting" | "completed" | "failed" | "reconciling",
): string {
  return {
    streaming: "Responding",
    waiting: "Waiting",
    completed: "Completed",
    failed: "Failed",
    reconciling: "Reconciling",
  }[state];
}

export function rosterPresentation(state: "loading" | "empty" | "error"): string {
  return {
    loading: "Loading conversations",
    empty: "No bots or channels",
    error: "Roster failed to load",
  }[state];
}
