import type { TurnEvent } from "./api";

/** Parse complete SSE frames from a buffer, returning the unparsed remainder. */
export function parseSseFrames(
  buffer: string,
  onEvent: (event: TurnEvent) => void,
): string {
  let remainder = buffer;
  while (remainder.includes("\n\n")) {
    const splitAt = remainder.indexOf("\n\n");
    const frame = remainder.slice(0, splitAt);
    remainder = remainder.slice(splitAt + 2);
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }
    const event = JSON.parse(dataLine.slice(5).trim()) as TurnEvent;
    onEvent(event);
  }
  return remainder;
}

export const TERMINAL_TURN_KINDS = new Set([
  "turn.completed",
  "turn.failed",
  "turn.reconciling",
]);

export function isTerminalTurnEvent(kind: string): boolean {
  return TERMINAL_TURN_KINDS.has(kind);
}
