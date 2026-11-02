/** How long a turn may show no progress before the member is told it is slow. */
export const TURN_SLOW_AFTER_MS = 45_000;

export const SLOW_TURN_TEXT = "Still working. This is taking longer than expected.";

export function isTurnSlow(millisecondsWithoutProgress: number): boolean {
  return millisecondsWithoutProgress >= TURN_SLOW_AFTER_MS;
}
