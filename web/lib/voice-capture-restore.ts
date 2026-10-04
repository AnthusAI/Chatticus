import {
  captureHealthProblem,
  type CaptureRestoreOutcome,
  type CaptureTrackState,
} from "./voice-control";

export const CAPTURE_RESUME_PATIENCE_MS = 1_000;
export const CAPTURE_VERIFY_WINDOW_MS = 1_500;
export const CAPTURE_VERIFY_STEP_MS = 100;

export interface CaptureRestoreDependencies {
  /** Asks the audio engine to run again; may reject, or never settle, on iOS. */
  resume: () => Promise<void>;
  /** The engine state and the microphone tracks as they are right now. */
  snapshot: () => { engineState: string; tracks: CaptureTrackState[] };
  /** Audio chunks delivered to the recognizer so far by the current capture, or null when they cannot be counted. */
  frameCount: () => number | null;
  /** Tears capture down and opens the microphone again; rejects when the browser refuses. */
  rebuild: () => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
}

async function verifyCapture(dependencies: CaptureRestoreDependencies): Promise<string | null> {
  const framesAtStart = dependencies.frameCount();
  let waited = 0;
  for (;;) {
    const { engineState, tracks } = dependencies.snapshot();
    const framesNow = dependencies.frameCount();
    const problem = captureHealthProblem({
      engineState,
      tracks,
      framesArrived: framesAtStart === null || framesNow === null ? null : framesNow > framesAtStart,
    });
    if (problem === null || waited >= CAPTURE_VERIFY_WINDOW_MS) {
      return problem;
    }
    await dependencies.sleep(CAPTURE_VERIFY_STEP_MS);
    waited += CAPTURE_VERIFY_STEP_MS;
  }
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "the browser would not reopen the microphone";
}

/**
 * Brings capture back after speech and proves it: wake the engine, verify the
 * engine runs, the track is live and unmuted, and audio is arriving; if not,
 * rebuild capture; if that is refused, ask for a tap.
 */
export async function restoreCapture(
  dependencies: CaptureRestoreDependencies,
): Promise<CaptureRestoreOutcome> {
  await Promise.race([
    dependencies.resume().catch(() => undefined),
    dependencies.sleep(CAPTURE_RESUME_PATIENCE_MS),
  ]);
  if ((await verifyCapture(dependencies)) === null) {
    return { kind: "listening" };
  }
  try {
    await dependencies.rebuild();
  } catch (error) {
    return { kind: "needsTap", reason: failureReason(error) };
  }
  const problemAfterRebuild = await verifyCapture(dependencies);
  return problemAfterRebuild === null
    ? { kind: "restarted" }
    : { kind: "needsTap", reason: problemAfterRebuild };
}
