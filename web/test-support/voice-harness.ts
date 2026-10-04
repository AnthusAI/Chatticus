import {
  replyForEndedTurn,
  routeVoiceLine,
  turnEndAnnouncement,
  voiceAvailability,
} from "../lib/voice-control";
import type { Bot, Channel } from "../lib/api";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action: "hear" | "availability" | "announceTurnEnd" | "announceEndedTurn";
  turn?: { bot_id: string; prompt_message_seq: number | null };
  committed?: import("../lib/api").Message[];
  overlapsSpeech?: boolean;
  listening?: boolean;
  botName?: string;
  body?: string;
  reason?: string;
  bots?: Bot[];
  channels?: Channel[];
  selectedId?: string | null;
  addressedBotId?: string | null;
  busyChannelIds?: string[];
  environment?: { crossOriginIsolated: boolean; hasMicrophone: boolean };
  line?: string;
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
} else if (input.action === "announceTurnEnd") {
  output = {
    spoken: turnEndAnnouncement({
      listening: input.listening ?? false,
      botName: input.botName ?? "",
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
          botName: input.botName ?? "",
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
