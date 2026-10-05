import type { Bot, Channel, Message } from "./api";

/**
 * What one completed line of speech does in the workspace. ``send`` hands the
 * raw transcript to the understand-the-user step on the server, which posts
 * what the member meant to the teammate in the open conversation.
 */
export type VoiceRoute =
  | {
      kind: "send";
      botId: string;
      channelId: string | null;
      transcript: string;
    }
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
    return {
      available: false,
      reason: "Voice needs this page to be cross-origin isolated.",
    };
  }
  if (!environment.hasMicrophone) {
    return {
      available: false,
      reason: "This browser does not offer a microphone.",
    };
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
    return {
      kind: "notice",
      text: "Open a conversation to talk to a teammate.",
    };
  }
  const channelId = openChannelId(workspace, botId);
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
export function spokenReply(body: string): string {
  return sentencesWithin(speakableText(body), MAX_SPOKEN_REPLY_CHARACTERS);
}

/** What the browser says aloud when a teammate's turn fails. */
export function spokenFailure(reason: string): string {
  return `That did not work. ${sentencesWithin(speakableText(reason), MAX_SPOKEN_REPLY_CHARACTERS)}`;
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
  { kind: "completed"; body: string } | { kind: "failed"; reason: string };

/**
 * What to say when a turn this browser was watching in the open conversation
 * ends, or ``null`` while listening is off.
 */
export function turnEndAnnouncement(ending: {
  listening: boolean;
  outcome: TurnEndOutcome;
}): string | null {
  if (!ending.listening) {
    return null;
  }
  return ending.outcome.kind === "completed"
    ? spokenReply(ending.outcome.body)
    : spokenFailure(ending.outcome.reason);
}

export const SPEECH_OVERLAP_MARGIN_MS = 500;

/** When a spoken reply began and ended, and when it should have ended if the engine never says. */
export interface SpeechWindow {
  startedAt: number;
  endedAt: number | null;
  expectedEndedAt: number;
}

export function lineOverlapsSpeechWindow(
  speechWindow: SpeechWindow | null,
  lineStartedAtMs: number,
): boolean {
  if (!speechWindow) {
    return false;
  }
  const endedAt = speechWindow.endedAt ?? speechWindow.expectedEndedAt;
  return (
    lineStartedAtMs >= speechWindow.startedAt - SPEECH_OVERLAP_MARGIN_MS &&
    lineStartedAtMs <= endedAt + SPEECH_OVERLAP_MARGIN_MS
  );
}

/**
 * When a line began, by the wall clock. The recognizer's own timeline stops
 * while the audio engine is suspended around speech, so it drifts behind the
 * clock and would place later lines inside the reply that was being spoken.
 */
export function lineStartedAtMs(completedAtMs: number, durationSeconds: number): number {
  return completedAtMs - durationSeconds * 1000;
}

export type VoicePhase =
  | "idle"
  | "loading"
  | "listening"
  | "needsTap"
  | "unavailable"
  | "error";

export interface VoiceButtonPresentation {
  icon: "AudioLines";
  label: string;
  look: "neutral" | "active" | "alert";
  pressed: boolean;
  disabled: boolean;
  pulsing: boolean;
}

/** What the voice button looks like for a session phase; one icon, so state shows in look and label. */
export function voiceButtonPresentation(
  phase: VoicePhase,
  speaking: boolean,
): VoiceButtonPresentation {
  if (phase === "listening") {
    return {
      icon: "AudioLines",
      label: "End voice conversation",
      look: "active",
      pressed: true,
      disabled: false,
      pulsing: speaking,
    };
  }
  if (phase === "loading") {
    return {
      icon: "AudioLines",
      label: "Loading voice model",
      look: "neutral",
      pressed: false,
      disabled: true,
      pulsing: false,
    };
  }
  if (phase === "needsTap") {
    return {
      icon: "AudioLines",
      label: "Tap to keep talking",
      look: "alert",
      pressed: false,
      disabled: false,
      pulsing: false,
    };
  }
  return {
    icon: "AudioLines",
    label: "Start voice conversation",
    look: phase === "idle" ? "neutral" : "alert",
    pressed: false,
    disabled: false,
    pulsing: false,
  };
}

/** Something the capture session reported; recognizer trouble is per-pass and capture carries on. */
export type VoiceSessionEvent = { kind: "recognizerTrouble"; message: string };

export function phaseAfterSessionEvent(
  phase: VoicePhase,
  event: VoiceSessionEvent,
): { phase: VoicePhase; note: string } {
  return { phase, note: `Voice hiccup: ${event.message}` };
}

/** How long capture may deliver no audio before it is treated as stopped. */
export const CAPTURE_STALL_MS = 1_500;

/**
 * Why capture should be restored right now, or null while it is healthy. Runs
 * continuously, speech or not: nothing here pauses capture around a reply.
 */
export function captureWatchProblem(watch: {
  engineState: string;
  tracks: CaptureTrackState[];
  millisecondsSinceFrame: number;
}): string | null {
  return captureHealthProblem({
    engineState: watch.engineState,
    tracks: watch.tracks,
    framesArrived: watch.millisecondsSinceFrame < CAPTURE_STALL_MS,
  });
}

export interface CaptureTrackState {
  readyState: string;
  muted: boolean;
}

export interface CaptureSnapshot {
  engineState: string;
  tracks: CaptureTrackState[];
  /** Whether audio chunks arrived during the check; null when they cannot be counted. */
  framesArrived: boolean | null;
}

/** Why capture is not really listening, or null when the engine runs, a track is live and unmuted, and audio arrives. */
export function captureHealthProblem(snapshot: CaptureSnapshot): string | null {
  if (snapshot.engineState !== "running") {
    return `the audio engine is ${snapshot.engineState}`;
  }
  if (!snapshot.tracks.some((track) => track.readyState === "live")) {
    return "the microphone track ended";
  }
  if (!snapshot.tracks.some((track) => track.readyState === "live" && !track.muted)) {
    return "the system muted the microphone";
  }
  if (snapshot.framesArrived === false) {
    return "no audio is arriving";
  }
  return null;
}

export type CaptureRestoreOutcome =
  | { kind: "listening" }
  | { kind: "restarted" }
  | { kind: "needsTap"; reason: string };

/** What the status line says about how capture came back after speech. */
export function captureRestoreNote(outcome: CaptureRestoreOutcome): string {
  if (outcome.kind === "listening") {
    return "Listening again.";
  }
  if (outcome.kind === "restarted") {
    return "Microphone restarted after speech.";
  }
  return `Tap to keep talking: ${outcome.reason}`;
}
