import {
  lineOverlapsSpeechWindow,
  lineStartedAtMs,
  phaseAfterSessionEvent,
  replyForEndedTurn,
  routeVoiceLine,
  turnEndAnnouncement,
  voiceAvailability,
  voiceButtonPresentation,
} from "../lib/voice-control";
import { speechDeadlineMs } from "../lib/voice-speech";
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
    | "lineStart";
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
  busyChannelIds?: string[];
  environment?: { crossOriginIsolated: boolean; hasMicrophone: boolean };
  line?: string;
  phase?: import("../lib/voice-control").VoicePhase;
  speaking?: boolean;
  event?: import("../lib/voice-control").VoiceSessionEvent;
};

let output: unknown;
if (input.action === "hear") {
  output = routeVoiceLine(input.line ?? "", {
    bots: input.bots ?? [],
    channels: input.channels ?? [],
    selectedId: input.selectedId ?? null,
    addressedBotId: input.addressedBotId ?? null,
    busyChannelIds: input.busyChannelIds ?? [],
    overlapsSpeech: input.overlapsSpeech ?? false,
  });
} else if (input.action === "hearAfterSpeech") {
  const startedAtMs = lineStartedAtMs(input.completedAtMs ?? 0, input.durationSeconds ?? 0);
  output = routeVoiceLine(input.line ?? "", {
    bots: input.bots ?? [],
    channels: input.channels ?? [],
    selectedId: input.selectedId ?? null,
    addressedBotId: input.addressedBotId ?? null,
    busyChannelIds: input.busyChannelIds ?? [],
    overlapsSpeech: lineOverlapsSpeechWindow(
      {
        startedAt: input.spokenAtMs ?? 0,
        endedAt: input.spokenEndedAtMs ?? null,
        expectedEndedAt: (input.spokenAtMs ?? 0) + speechDeadlineMs(input.spokenText ?? ""),
      },
      startedAtMs,
    ),
  });
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

process.stdout.write(JSON.stringify(output));
