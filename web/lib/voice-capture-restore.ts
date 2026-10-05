import {
  captureHealthProblem,
  type CaptureRestoreOutcome,
  type CaptureTrackState,
} from "./voice-control";

export const CAPTURE_RESUME_PATIENCE_MS = 1_000;
export const CAPTURE_VERIFY_WINDOW_MS = 1_500;
export const CAPTURE_VERIFY_STEP_MS = 100;
export const CAPTURE_REBUILD_LIMIT = 3;
export const CAPTURE_REBUILD_WINDOW_MS = 60_000;

/** Whether another rebuild fits in the budget: at most the limit within the window. */
export function rebuildsAllowed(rebuildTimesMs: number[], nowMs: number): boolean {
  const recent = rebuildTimesMs.filter((time) => nowMs - time < CAPTURE_REBUILD_WINDOW_MS);
  return recent.length < CAPTURE_REBUILD_LIMIT;
}

/** A microphone stream and a running-or-resuming audio context, both opened inside a tap. */
export interface OpenedAudio {
  stream: MediaStream;
  audioContext: AudioContext;
}

export interface CaptureRestoreDependencies {
  /** Asks the audio engine to run again; may reject, or never settle, on iOS. */
  resume: () => Promise<void>;
  /** The engine state and the microphone tracks as they are right now. */
  snapshot: () => { engineState: string; tracks: CaptureTrackState[] };
  /** Audio chunks delivered to the recognizer so far by the current capture, or null when they cannot be counted. */
  frameCount: () => number | null;
  /**
   * Tears capture down and opens the microphone again, using the supplied
   * stream and audio context when they were opened inside a tap; rejects when
   * the browser refuses.
   */
  rebuild: (openedAudio?: OpenedAudio) => Promise<void>;
  /** False when recent rebuilds used up the budget and another would only cycle. */
  rebuildAllowed: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface TapRestoreDependencies extends CaptureRestoreDependencies {
  /**
   * Requests the microphone, creates an audio context and calls its resume,
   * all synchronously before returning, so the tap still counts as the gesture.
   */
  openAudio: () => Promise<OpenedAudio>;
  /** Stops the tracks and closes the context of audio that was opened but not kept. */
  discardOpenedAudio: (openedAudio: OpenedAudio) => void;
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

async function rebuildAndVerify(
  dependencies: CaptureRestoreDependencies,
  openedAudio: OpenedAudio | undefined,
  discard: () => void,
): Promise<CaptureRestoreOutcome> {
  if (!dependencies.rebuildAllowed()) {
    discard();
    return { kind: "needsTap", reason: "the microphone keeps stalling" };
  }
  try {
    await dependencies.rebuild(openedAudio);
  } catch (error) {
    discard();
    return { kind: "needsTap", reason: failureReason(error) };
  }
  const problemAfterRebuild = await verifyCapture(dependencies);
  return problemAfterRebuild === null
    ? { kind: "restarted" }
    : { kind: "needsTap", reason: problemAfterRebuild };
}

/**
 * Brings capture back and proves it: wake the engine, verify the engine runs,
 * the track is live and unmuted, and audio is arriving; if not, rebuild
 * capture (within the rebuild budget); if that is refused, ask for a tap.
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
  return rebuildAndVerify(dependencies, undefined, () => undefined);
}

/**
 * Restores capture from a tap. The microphone is requested and an audio
 * context is created and resumed synchronously, before any await, so the
 * browser still counts the tap as the user gesture. Both are handed to the
 * rebuild; there is no resume wait or verification before it.
 */
export async function restoreCaptureFromTap(
  dependencies: TapRestoreDependencies,
): Promise<CaptureRestoreOutcome> {
  const opening = dependencies.openAudio();
  let openedAudio: OpenedAudio;
  try {
    openedAudio = await opening;
  } catch (error) {
    return { kind: "needsTap", reason: failureReason(error) };
  }
  return rebuildAndVerify(dependencies, openedAudio, () =>
    dependencies.discardOpenedAudio(openedAudio),
  );
}
