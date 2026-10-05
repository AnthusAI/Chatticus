import {
  lineOverlapsSpeechWindow,
  lineStartedAtMs,
  captureRestoreNote,
  captureWatchProblem,
  phaseAfterSessionEvent,
  replyForEndedTurn,
  routeVoiceLine,
  turnEndAnnouncement,
  voiceAvailability,
  voiceButtonPresentation,
} from "../lib/voice-control";
import {
  rebuildsAllowed,
  restoreCapture,
  restoreCaptureFromTap,
} from "../lib/voice-capture-restore";
import {
  createVoiceLineDelivery,
  type VoiceSendOutcome,
} from "../lib/voice-line-delivery";
import { createCaptureWatch } from "../lib/voice-capture-watch";
import {
  lineMayBeOwnSpeech,
  speakingStateIsStuck,
  speechDeadlineMs,
  speechEndNote,
  speechWatchdogShouldEnd,
} from "../lib/voice-speech";
import type { Bot, Channel } from "../lib/api";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action:
    | "hear"
    | "buttonPresentation"
    | "sessionEvent"
    | "availability"
    | "announceTurnEnd"
    | "announceEndedTurn"
    | "hearAfterSpeech"
    | "lineStart"
    | "captureWatch"
    | "captureRestore"
    | "captureWatchSpeech"
    | "tapRestore"
    | "watchdog"
    | "speechEndNote"
    | "deliver"
    | "stuckSpeech";
  spokenText?: string;
  spokenAtMs?: number;
  spokenEndedAtMs?: number | null;
  completedAtMs?: number;
  durationSeconds?: number;
  turn?: { bot_id: string; prompt_message_seq: number | null };
  committed?: import("../lib/api").Message[];
  overlapsSpeech?: boolean;
  listening?: boolean;
  body?: string;
  reason?: string;
  bots?: Bot[];
  channels?: Channel[];
  selectedId?: string | null;
  addressedBotId?: string | null;
  delivery?: {
    busy: boolean;
    sendOutcome: "sent" | "nothingToSend" | "failed";
    recoversAfterFailure?: boolean;
    checkFails: boolean;
    replySpeaking: boolean;
    events: Array<{
      do: "hear" | "endTurn" | "switchConversation" | "advance" | "replyEnds";
      milliseconds?: number;
      line?: string;
      overlapsSpeech?: boolean;
    }>;
  };
  speakingFlag?: boolean;
  millisecondsPastExpectedEnd?: number;
  engineBusy?: boolean;
  overlapsSpeechWindow?: boolean;
  environment?: { crossOriginIsolated: boolean; hasMicrophone: boolean };
  line?: string;
  phase?: import("../lib/voice-control").VoicePhase;
  speaking?: boolean;
  engineState?: string;
  trackMuted?: boolean;
  trackEnded?: boolean;
  millisecondsSinceFrame?: number;
  inGesture?: boolean;
  capture?: {
    engineState: string;
    trackMuted: boolean;
    resumeWorks: boolean;
    rebuildNeedsGesture: boolean;
  };
  rebuildsInLastMinute?: number;
  started?: boolean;
  millisecondsSinceQueued?: number;
  engineBusy?: boolean;
  event?: import("../lib/voice-control").VoiceSessionEvent;
};

let output: unknown;
let pendingOutput: Promise<unknown> | undefined;
if (input.action === "hear") {
  output = routeVoiceLine(input.line ?? "", {
    bots: input.bots ?? [],
    channels: input.channels ?? [],
    selectedId: input.selectedId ?? null,
    addressedBotId: input.addressedBotId ?? null,
    overlapsSpeech: input.overlapsSpeech ?? false,
  });
} else if (input.action === "hearAfterSpeech") {
  const startedAtMs = lineStartedAtMs(input.completedAtMs ?? 0, input.durationSeconds ?? 0);
  output = routeVoiceLine(input.line ?? "", {
    bots: input.bots ?? [],
    channels: input.channels ?? [],
    selectedId: input.selectedId ?? null,
    addressedBotId: input.addressedBotId ?? null,
    overlapsSpeech: lineOverlapsSpeechWindow(
      {
        startedAt: input.spokenAtMs ?? 0,
        endedAt: input.spokenEndedAtMs ?? null,
        expectedEndedAt: (input.spokenAtMs ?? 0) + speechDeadlineMs(input.spokenText ?? ""),
      },
      startedAtMs,
    ),
  });
} else if (input.action === "stuckSpeech") {
  const stuck = speakingStateIsStuck({
    speakingFlag: input.speakingFlag ?? false,
    millisecondsPastExpectedEnd: input.millisecondsPastExpectedEnd ?? 0,
    engineBusy: input.engineBusy ?? false,
  });
  const overlapsSpeech = lineMayBeOwnSpeech({
    overlapsSpeechWindow: input.overlapsSpeechWindow ?? false,
    speakingFlag: input.speakingFlag ?? false,
    speakingStateStuck: stuck,
  });
  output = { stuck, overlapsSpeech };
} else if (input.action === "deliver") {
  const script = input.delivery;
  const world = {
    turnActive: script?.busy ?? false,
    itemId: input.selectedId ?? null,
    clock: 1_000_000,
    replying: script?.replySpeaking ?? false,
    timers: [] as Array<{ dueAt: number; action: () => void }>,
  };
  const sent: string[] = [];
  const spoken: string[] = [];
  const notes: string[] = [];
  const shown: string[] = [];
  const delivery = createVoiceLineDelivery({
    workspace: () => ({
      bots: input.bots ?? [],
      channels: input.channels ?? [],
      selectedId: world.itemId,
      addressedBotId: input.addressedBotId ?? null,
    }),
    botName: (botId) => (input.bots ?? []).find((bot) => bot.bot_id === botId)?.name ?? "your teammate",
    turnIsActive: async () => {
      if (script?.checkFails) throw new Error("offline");
      return world.turnActive;
    },
    sendIsInFlight: () => false,
    sendLine: async (_botId, _channelId, transcript): Promise<VoiceSendOutcome> => {
      sent.push(transcript);
      if (script?.sendOutcome === "failed" && !script.recoversAfterFailure) {
        return { kind: "failed" };
      }
      if (script?.sendOutcome === "failed" && script.recoversAfterFailure && sent.length === 1) {
        return { kind: "failed" };
      }
      if (script?.sendOutcome === "nothingToSend") return { kind: "nothingToSend" };
      world.turnActive = true;
      return { kind: "sent", understood: transcript, degraded: false };
    },
    openItemId: () => world.itemId,
    speakFeedback: (text) => spoken.push(text),
    replyIsSpeaking: () => world.replying,
    notify: (note) => notes.push(note),
    stopSpeaking: () => undefined,
    stopListening: async () => undefined,
    retryLater: (action, milliseconds) => {
      world.timers.push({ dueAt: world.clock + milliseconds, action });
    },
    now: () => world.clock,
  });
  pendingOutput = (async () => {
    for (const event of script?.events ?? []) {
      if (event.do === "hear") {
        shown.push(await delivery.handleLine(event.line ?? "", { overlapsSpeech: event.overlapsSpeech ?? false }));
      } else if (event.do === "endTurn") {
        world.turnActive = false;
        const channelId = (input.channels ?? [])[0]?.channel_id ?? "";
        await delivery.flush(channelId, { afterTurn: true });
      } else if (event.do === "advance") {
        world.clock += event.milliseconds ?? 0;
        const due = world.timers.filter((timer) => timer.dueAt <= world.clock);
        world.timers = world.timers.filter((timer) => timer.dueAt > world.clock);
        for (const timer of due) {
          timer.action();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      } else if (event.do === "replyEnds") {
        world.replying = false;
        delivery.replyEnded();
      } else {
        world.itemId = "bot:elsewhere";
        delivery.clear("you switched conversations");
      }
    }
    return { sent, spoken, notes, shown };
  })();
} else if (input.action === "captureWatch") {
  output = {
    problem: captureWatchProblem({
      engineState: input.engineState ?? "running",
      tracks: [{ readyState: input.trackEnded ? "ended" : "live", muted: input.trackMuted ?? false }],
      millisecondsSinceFrame: input.millisecondsSinceFrame ?? 0,
    }),
  };
} else if (input.action === "captureRestore" || input.action === "tapRestore") {
  const fake = {
    engineState: input.capture?.engineState ?? "running",
    muted: input.capture?.trackMuted ?? false,
    frames: 0,
  };
  const calls: string[] = [];
  const rebuildTimes = Array.from({ length: input.rebuildsInLastMinute ?? 0 }, () => 0);
  const dependencies = {
    resume: async () => {
      calls.push("resume");
      if (input.capture?.resumeWorks) fake.engineState = "running";
    },
    snapshot: () => ({
      engineState: fake.engineState,
      tracks: [{ readyState: "live" as const, muted: fake.muted }],
    }),
    frameCount: () => fake.frames,
    rebuild: async () => {
      calls.push("rebuild");
      if (input.capture?.rebuildNeedsGesture && !input.inGesture) {
        throw new Error("The browser needs a tap to reopen the microphone.");
      }
      fake.engineState = "running";
      fake.muted = false;
    },
    rebuildAllowed: () => rebuildsAllowed(rebuildTimes, 1),
    sleep: async () => {
      if (fake.engineState === "running") fake.frames += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
  const finish = (outcome: import("../lib/voice-control").CaptureRestoreOutcome) => ({
    ...outcome,
    note: captureRestoreNote(outcome),
    button: voiceButtonPresentation(outcome.kind === "needsTap" ? "needsTap" : "listening", false),
  });
  if (input.action === "captureRestore") {
    pendingOutput = restoreCapture(dependencies).then(finish);
  } else {
    const opened = {
      stream: { getTracks: () => [] },
      audioContext: {},
    } as unknown as import("../lib/voice-capture-restore").OpenedAudio;
    const pending = restoreCaptureFromTap({
      ...dependencies,
      openAudio: async () => {
        calls.push("getUserMedia", "AudioContext", "resume");
        return opened;
      },
      discardOpenedAudio: () => undefined,
    });
    const callsBeforeAnyAwait = [...calls];
    pendingOutput = pending.then((outcome) => ({
      ...finish(outcome),
      callsBeforeAnyAwait,
    }));
  }
} else if (input.action === "captureWatchSpeech") {
  const calls: string[] = [];
  const state = { speaking: true, stalled: true, suspended: input.engineState === "suspended" };
  const watch = createCaptureWatch({
    isStopped: () => false,
    isSpeaking: () => state.speaking,
    problem: () =>
      state.suspended
        ? captureWatchProblem({
            engineState: "suspended",
            tracks: [{ readyState: "live", muted: false }],
            millisecondsSinceFrame: 0,
          })
        : captureWatchProblem({
            engineState: "running",
            tracks: [{ readyState: "live", muted: false }],
            millisecondsSinceFrame: input.millisecondsSinceFrame ?? 0,
          }),
    restore: async () => {
      calls.push(state.suspended ? "resume" : "getUserMedia");
      return { kind: "listening" as const };
    },
    report: () => undefined,
  });
  watch.check();
  watch.check();
  const callsDuringSpeech = [...calls];
  state.speaking = false;
  watch.speechEnded();
  pendingOutput = new Promise((resolve) => setTimeout(resolve, 0)).then(() => ({
    callsDuringSpeech,
    callsAfterSpeech: [...calls],
  }));
} else if (input.action === "watchdog") {
  output = {
    ends: speechWatchdogShouldEnd({
      started: input.started ?? false,
      millisecondsSinceQueued: input.millisecondsSinceQueued ?? 0,
      engineBusy: input.engineBusy ?? false,
    }),
  };
} else if (input.action === "speechEndNote") {
  output = { note: speechEndNote(input.reason ?? "finished") };
} else if (input.action === "lineStart") {
  output = { startedAtMs: lineStartedAtMs(input.completedAtMs ?? 0, input.durationSeconds ?? 0) };
} else if (input.action === "buttonPresentation") {
  output = voiceButtonPresentation(input.phase ?? "idle", input.speaking ?? false);
} else if (input.action === "sessionEvent") {
  output = phaseAfterSessionEvent(
    input.phase ?? "idle",
    input.event ?? { kind: "recognizerTrouble", message: "" },
  );
} else if (input.action === "announceTurnEnd") {
  output = {
    spoken: turnEndAnnouncement({
      listening: input.listening ?? false,
      outcome:
        input.reason !== undefined
          ? { kind: "failed", reason: input.reason }
          : { kind: "completed", body: input.body ?? "" },
    }),
  };
} else if (input.action === "announceEndedTurn") {
  const reply = replyForEndedTurn(
    input.turn ?? { bot_id: "", prompt_message_seq: null },
    input.committed ?? [],
  );
  output = {
    spoken: reply
      ? turnEndAnnouncement({
          listening: input.listening ?? false,
              outcome: { kind: "completed", body: reply.body },
        })
      : null,
  };
} else {
  output = voiceAvailability(
    input.environment ?? { crossOriginIsolated: true, hasMicrophone: true },
  );
}

void Promise.resolve(pendingOutput ?? output).then((result) =>
  process.stdout.write(JSON.stringify(result)),
);
