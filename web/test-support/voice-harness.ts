import { routeVoiceLine, turnEndAnnouncement, voiceAvailability } from "../lib/voice-control";
import type { Bot, Channel } from "../lib/api";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action: "hear" | "availability" | "announceTurnEnd";
  overlapsSpeech?: boolean;
  listening?: boolean;
  conversationOpen?: boolean;
  botName?: string;
  body?: string;
  reason?: string;
  bots?: Bot[];
  channels?: Channel[];
  selectedId?: string | null;
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
    busyChannelIds: input.busyChannelIds ?? [],
    overlapsSpeech: input.overlapsSpeech ?? false,
  });
} else if (input.action === "announceTurnEnd") {
  output = {
    spoken: turnEndAnnouncement({
      listening: input.listening ?? false,
      conversationOpen: input.conversationOpen ?? true,
      botName: input.botName ?? "",
      outcome:
        input.reason !== undefined
          ? { kind: "failed", reason: input.reason }
          : { kind: "completed", body: input.body ?? "" },
    }),
  };
} else {
  output = voiceAvailability(
    input.environment ?? { crossOriginIsolated: true, hasMicrophone: true },
  );
}

process.stdout.write(JSON.stringify(output));
