import { routeVoiceLine, type VoiceWorkspace } from "./voice-control";

export const FEEDBACK_NOTHING_TO_SEND = "Didn't catch a message there.";
export const FEEDBACK_IGNORED_AS_ECHO = "Ignored that as an echo. Say it again.";
export const FEEDBACK_OPEN_A_CONVERSATION = "Open a conversation first.";
export const FEEDBACK_COULD_NOT_SEND = "Couldn't send that.";

/**
 * Lines queued while a teammate works are joined with one space into a single
 * message. A space, not a newline: the understand-the-user step repairs one
 * spoken stretch at a time, and a newline would read to the teammate as
 * separate paragraphs of a written message instead of continuing speech.
 */
export const QUEUED_LINE_SEPARATOR = " ";

export const DRAIN_RETRY_MS = 1_500;

/** Spoken echo feedback is rate-limited so its own tail, heard back, cannot start a loop. */
export const FEEDBACK_MINIMUM_GAP_MS = 10_000;

/** How long a send that failed waits before it is tried again on its own. */
export const FAILED_SEND_RETRY_MS = 5_000;

export type VoiceSendOutcome =
  | { kind: "sent"; understood: string; degraded: boolean }
  | { kind: "nothingToSend" }
  | { kind: "failed" };

export interface VoiceDeliveryDependencies {
  workspace: () => Omit<VoiceWorkspace, "overlapsSpeech">;
  botName: (botId: string) => string;
  turnIsActive: (channelId: string) => Promise<boolean>;
  sendIsInFlight: () => boolean;
  sendLine: (botId: string, channelId: string, transcript: string) => Promise<VoiceSendOutcome>;
  openItemId: () => string | null;
  speakFeedback: (text: string) => void;
  replyIsSpeaking: () => boolean;
  notify: (note: string) => void;
  stopSpeaking: (reason: string) => void;
  stopListening: () => Promise<void>;
  retryLater: (action: () => void, milliseconds: number) => void;
  now: () => number;
}

interface QueuedChannel {
  botId: string;
  itemId: string | null;
  lines: string[];
  parkedAfterFailure: boolean;
  consecutiveFailures: number;
}

function noteForOutcome(outcome: VoiceSendOutcome, botName: string, transcript: string): string {
  if (outcome.kind === "failed") {
    return `Could not send to ${botName}.`;
  }
  if (outcome.kind === "nothingToSend") {
    return `Heard "${transcript}". Nothing to send.`;
  }
  return outcome.degraded
    ? `Heard "${transcript}". Sent to ${botName} as heard.`
    : `Heard "${transcript}". Sent to ${botName}: "${outcome.understood}"`;
}

/**
 * Delivers heard lines to the open conversation without ever dropping one
 * silently. A line heard while the teammate works or a send is in flight waits
 * in an ordered per-channel queue and goes out, joined into one message, as
 * soon as the turn ends. Outcomes that neither send nor queue are spoken.
 */
export function createVoiceLineDelivery(dependencies: VoiceDeliveryDependencies) {
  const queues = new Map<string, QueuedChannel>();
  const draining = new Set<string>();
  const retryPending = new Set<string>();
  let lastEchoFeedbackAt: number | null = null;
  let deferredFeedback: string[] = [];

  const speakEchoFeedback = (text: string) => {
    const current = dependencies.now();
    const recentlySpoke =
      lastEchoFeedbackAt !== null && current - lastEchoFeedbackAt < FEEDBACK_MINIMUM_GAP_MS;
    if (recentlySpoke || dependencies.replyIsSpeaking()) {
      return;
    }
    lastEchoFeedbackAt = current;
    dependencies.speakFeedback(text);
  };

  const speakDropFeedback = (text: string) => {
    if (dependencies.replyIsSpeaking()) {
      if (!deferredFeedback.includes(text)) {
        deferredFeedback.push(text);
      }
      return;
    }
    dependencies.speakFeedback(text);
  };

  const scheduleRetry = (channelId: string, milliseconds: number) => {
    if (retryPending.has(channelId)) {
      return;
    }
    retryPending.add(channelId);
    dependencies.retryLater(() => {
      retryPending.delete(channelId);
      void delivery.flush(channelId, { afterTurn: true });
    }, milliseconds);
  };

  const drain = async (channelId: string): Promise<string | null> => {
    if (draining.has(channelId)) {
      return null;
    }
    draining.add(channelId);
    let firstNote: string | null = null;
    const speakFeedback = (text: string) => speakDropFeedback(text);
    const report = (note: string) => {
      if (firstNote === null) {
        firstNote = note;
      } else {
        dependencies.notify(note);
      }
    };
    try {
      for (;;) {
        const queued = queues.get(channelId);
        if (!queued || queued.lines.length === 0 || dependencies.sendIsInFlight()) {
          break;
        }
        const botName = dependencies.botName(queued.botId);
        let active: boolean;
        try {
          active = await dependencies.turnIsActive(channelId);
        } catch {
          queues.delete(channelId);
          speakFeedback(FEEDBACK_COULD_NOT_SEND);
          report(`Could not check whether ${botName} is free, so that line was not sent.`);
          break;
        }
        if (active || dependencies.sendIsInFlight()) {
          break;
        }
        if (dependencies.openItemId() !== queued.itemId) {
          queues.delete(channelId);
          report(`You switched conversations, so that line was not sent to ${botName}.`);
          break;
        }
        const transcript = queued.lines.join(QUEUED_LINE_SEPARATOR);
        queued.lines = [];
        const outcome = await dependencies.sendLine(queued.botId, channelId, transcript);
        if (outcome.kind === "failed") {
          queued.lines = [transcript, ...queued.lines];
          queued.parkedAfterFailure = true;
          queued.consecutiveFailures += 1;
          if (queued.consecutiveFailures === 1) {
            speakFeedback(FEEDBACK_COULD_NOT_SEND);
            scheduleRetry(channelId, FAILED_SEND_RETRY_MS);
          }
          report(noteForOutcome(outcome, botName, transcript));
          break;
        }
        queued.consecutiveFailures = 0;
        if (queued.lines.length === 0) {
          queues.delete(channelId);
        }
        if (outcome.kind === "nothingToSend") {
          speakFeedback(FEEDBACK_NOTHING_TO_SEND);
        }
        report(noteForOutcome(outcome, botName, transcript));
      }
    } finally {
      draining.delete(channelId);
    }
    return firstNote;
  };

  const waitingNote = (channelId: string): string => {
    const queued = queues.get(channelId);
    const botName = queued ? dependencies.botName(queued.botId) : "your teammate";
    return `Will send when ${botName} is done: "${(queued?.lines ?? []).join(QUEUED_LINE_SEPARATOR)}"`;
  };

  const delivery = {
    /** Handles one heard line and returns the note to show for it. */
    async handleLine(text: string, line: { overlapsSpeech: boolean }): Promise<string> {
      const route = routeVoiceLine(text, {
        ...dependencies.workspace(),
        overlapsSpeech: line.overlapsSpeech,
      });
      if (route.kind === "stopSpeaking") {
        dependencies.stopSpeaking("you said stop");
        return "Stopped speaking.";
      }
      if (route.kind === "discard") {
        if (text.trim() && line.overlapsSpeech) {
          speakEchoFeedback(FEEDBACK_IGNORED_AS_ECHO);
          return `Ignored while speaking: "${text.trim()}"`;
        }
        return "";
      }
      if (route.kind === "notice") {
        speakDropFeedback(FEEDBACK_OPEN_A_CONVERSATION);
        return route.text;
      }
      if (route.kind === "stopListening") {
        await dependencies.stopListening();
        return "Stopped listening.";
      }
      if (!route.channelId) {
        speakDropFeedback(FEEDBACK_OPEN_A_CONVERSATION);
        return "Open a conversation to talk to a teammate.";
      }
      const channelId = route.channelId;
      const existing = queues.get(channelId);
      if (existing) {
        existing.botId = route.botId;
        existing.lines.push(route.transcript);
        existing.parkedAfterFailure = false;
        existing.consecutiveFailures = 0;
      } else {
        queues.set(channelId, {
          botId: route.botId,
          itemId: dependencies.openItemId(),
          lines: [route.transcript],
          parkedAfterFailure: false,
          consecutiveFailures: 0,
        });
      }
      return (await drain(channelId)) ?? waitingNote(channelId);
    },

    /** Called when a turn or a send ends: delivers whatever queued behind it. */
    async flush(channelId: string, options: { afterTurn?: boolean } = {}): Promise<void> {
      const queued = queues.get(channelId);
      if (draining.has(channelId) || !queued || queued.lines.length === 0) {
        return;
      }
      if (queued.parkedAfterFailure && !options.afterTurn) {
        return;
      }
      queued.parkedAfterFailure = false;
      const note = await drain(channelId);
      if (note) {
        dependencies.notify(note);
      }
      const remaining = queues.get(channelId);
      if (
        remaining &&
        remaining.lines.length > 0 &&
        !remaining.parkedAfterFailure &&
        !retryPending.has(channelId)
      ) {
        scheduleRetry(channelId, DRAIN_RETRY_MS);
      }
    },

    /** Called when a spoken reply ends: speaks feedback that waited for it. */
    replyEnded(): void {
      const waiting = deferredFeedback;
      deferredFeedback = [];
      if (waiting.length > 0) {
        dependencies.speakFeedback(waiting.join(" "));
      }
    },

    /** Drops every queued line, for switching conversation or stopping voice, and says so. */
    clear(reason: string): void {
      let dropped = 0;
      queues.forEach((queued) => {
        dropped += queued.lines.length;
      });
      queues.clear();
      if (dropped > 0) {
        dependencies.notify(
          `${dropped} unsent ${dropped === 1 ? "line was" : "lines were"} dropped because ${reason}.`,
        );
      }
    },
  };
  return delivery;
}

export type VoiceLineDelivery = ReturnType<typeof createVoiceLineDelivery>;
