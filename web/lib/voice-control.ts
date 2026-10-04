import type { Bot, Channel, Message } from "./api";

/**
 * What one completed line of speech does in the workspace. ``send`` hands the
 * raw transcript to the understand-the-user step on the server, which posts
 * what the member meant to the teammate in the open conversation.
 */
export type VoiceRoute =
  | { kind: "send"; botId: string; channelId: string | null; transcript: string }
  | { kind: "stopListening" }
  | { kind: "stopSpeaking" }
  | { kind: "notice"; text: string }
  | { kind: "discard" };

export interface VoiceWorkspace {
  bots: Bot[];
  channels: Channel[];
  /** The open roster item: ``bot:<id>`` for a direct conversation, ``channel:<id>`` for a named one. */
  selectedId: string | null;
  /** The teammate chosen to answer in the open conversation. */
  addressedBotId: string | null;
  busyChannelIds: string[];
  /**
   * Whether the line began while a reply was being spoken (or just after).
   * Such a line may be the browser hearing itself, so only stop commands act.
   */
  overlapsSpeech?: boolean;
}

export interface VoiceEnvironment {
  crossOriginIsolated: boolean;
  hasMicrophone: boolean;
}

export type VoiceAvailability = { available: true } | { available: false; reason: string };

const STOP_LISTENING_PHRASES = ["stop listening", "stop listening please"];
const STOP_SPEAKING_PHRASES = [
  "stop",
  "stop please",
  "quiet",
  "quiet please",
  "stop talking",
  "skip",
  "that's enough",
];

/** The most a spoken reply says before pointing to the screen. */
export const MAX_SPOKEN_REPLY_CHARACTERS = 300;
const REST_ON_SCREEN = "The rest is on screen.";

export function voiceAvailability(environment: VoiceEnvironment): VoiceAvailability {
  if (!environment.crossOriginIsolated) {
    return { available: false, reason: "Voice needs this page to be cross-origin isolated." };
  }
  if (!environment.hasMicrophone) {
    return { available: false, reason: "This browser does not offer a microphone." };
  }
  return { available: true };
}

export function normalizeSpokenText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words to bias the speech-to-text decoder towards: the teammates' names. */
export function voiceKeyterms(bots: Bot[]): string[] {
  return [...new Set(bots.map((bot) => bot.name.trim()).filter(Boolean))];
}

function openChannelId(workspace: VoiceWorkspace, botId: string): string | null {
  if (workspace.selectedId?.startsWith("channel:")) {
    return workspace.selectedId.slice("channel:".length);
  }
  return (
    workspace.channels.find(
      (channel) =>
        channel.kind === "direct" &&
        channel.participants.some(
          (participant) => participant.kind === "bot" && participant.actor_id === botId,
        ),
    )?.channel_id ?? null
  );
}

/**
 * Decides what a completed line of speech does. There is no wake word: while
 * listening, every line goes to the teammate in the open conversation, except
 * the local commands, and except lines that may be the browser hearing its
 * own spoken reply.
 */
export function routeVoiceLine(text: string, workspace: VoiceWorkspace): VoiceRoute {
  const normalized = normalizeSpokenText(text);
  if (!normalized) {
    return { kind: "discard" };
  }
  if (STOP_LISTENING_PHRASES.includes(normalized)) {
    return { kind: "stopListening" };
  }
  if (workspace.overlapsSpeech) {
    return STOP_SPEAKING_PHRASES.includes(normalized)
      ? { kind: "stopSpeaking" }
      : { kind: "discard" };
  }
  const botId = workspace.selectedId ? workspace.addressedBotId : null;
  if (!botId) {
    return { kind: "notice", text: "Open a conversation to talk to a teammate." };
  }
  const channelId = openChannelId(workspace, botId);
  if (channelId && workspace.busyChannelIds.includes(channelId)) {
    const name = workspace.bots.find((bot) => bot.bot_id === botId)?.name ?? "Your teammate";
    return { kind: "notice", text: `${name} is still working. Say it again when ${name} is done.` };
  }
  return { kind: "send", botId, channelId, transcript: text.trim() };
}

const MAX_SPEAKABLE_INPUT_CHARACTERS = 2_000;

function speakableText(markdown: string): string {
  const inlineCode: string[] = [];
  const withoutCode = markdown
    .slice(0, MAX_SPEAKABLE_INPUT_CHARACTERS)
    .replace(/```[\s\S]*?```/g, "\nthe code on screen.\n")
    .replace(/```[\s\S]*$/, "\nthe code on screen.\n")
    .replace(/`([^`\n]*)`/g, (_match, code: string) => {
      inlineCode.push(code);
      return `\u0000${inlineCode.length - 1}\u0000`;
    });
  return withoutCode
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+?(?=[.,;:!?)]*(?:\s|$))/g, "the link on screen")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?=[^\w]|$)/g, "$1$2")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => inlineCode[Number(index)] ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentencesWithin(text: string, maximumCharacters: number): string {
  if (text.length <= maximumCharacters) {
    return text;
  }
  const sentences = text.split(/(?<=[.!?])\s+/);
  let kept = "";
  for (const sentence of sentences) {
    const next = kept ? `${kept} ${sentence}` : sentence;
    if (kept && next.length > maximumCharacters) {
      break;
    }
    kept = next;
  }
  if (kept.length > maximumCharacters) {
    kept = `${kept.slice(0, maximumCharacters).replace(/\s+\S*$/, "")}…`;
  }
  return `${kept} ${REST_ON_SCREEN}`;
}

/** What the browser says aloud for a teammate's reply. */
export function spokenReply(botName: string, body: string): string {
  return `${botName} says: ${sentencesWithin(speakableText(body), MAX_SPOKEN_REPLY_CHARACTERS)}`;
}

/** What the browser says aloud when a teammate's turn fails. */
export function spokenFailure(botName: string, reason: string): string {
  return `${botName} could not answer. ${sentencesWithin(speakableText(reason), MAX_SPOKEN_REPLY_CHARACTERS)}`;
}

/** The bot's committed answer to a turn: its newest message after the prompt. */
export function replyForEndedTurn(
  turn: { bot_id: string; prompt_message_seq?: number | null },
  committed: Message[],
): Message | null {
  return (
    [...committed]
      .sort((left, right) => right.seq - left.seq)
      .find(
        (message) =>
          message.author_kind === "bot" &&
          message.author_id === turn.bot_id &&
          (turn.prompt_message_seq == null || message.seq > turn.prompt_message_seq),
      ) ?? null
  );
}

export type TurnEndOutcome =
  | { kind: "completed"; body: string }
  | { kind: "failed"; reason: string };

/**
 * What to say when a turn this browser was watching in the open conversation
 * ends, or ``null`` while listening is off.
 */
export function turnEndAnnouncement(ending: {
  listening: boolean;
  botName: string;
  outcome: TurnEndOutcome;
}): string | null {
  if (!ending.listening) {
    return null;
  }
  return ending.outcome.kind === "completed"
    ? spokenReply(ending.botName, ending.outcome.body)
    : spokenFailure(ending.botName, ending.outcome.reason);
}
