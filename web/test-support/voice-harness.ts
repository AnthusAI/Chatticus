import {
  routeVoiceLine,
  spokenFailure,
  spokenReply,
  voiceAvailability,
} from "../lib/voice-control";
import type { Bot, Channel } from "../lib/api";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action: "hear" | "availability" | "speakReply" | "speakFailure";
  speaking?: boolean;
  listening?: boolean;
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
    speaking: input.speaking ?? false,
  });
} else if (input.action === "speakReply") {
  output = {
    spoken: input.listening ? spokenReply(input.botName ?? "", input.body ?? "") : null,
  };
} else if (input.action === "speakFailure") {
  output = {
    spoken: input.listening ? spokenFailure(input.botName ?? "", input.reason ?? "") : null,
  };
} else {
  output = voiceAvailability(
    input.environment ?? { crossOriginIsolated: true, hasMicrophone: true },
  );
}

process.stdout.write(JSON.stringify(output));
