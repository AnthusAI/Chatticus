import { routeVoiceLine, voiceAvailability } from "../lib/voice-control";
import type { Bot, Channel } from "../lib/api";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action: "hear" | "availability";
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
  });
} else {
  output = voiceAvailability(
    input.environment ?? { crossOriginIsolated: true, hasMicrophone: true },
  );
}

process.stdout.write(JSON.stringify(output));
