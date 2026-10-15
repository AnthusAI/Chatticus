import { LISTENING_CUE, type VoicePhase, type VoiceStartStage } from "./voice-control";

export interface VoiceStartDependencies<Session extends { stop: () => Promise<void> }> {
  /** Loads the model and opens the microphone; resolves only once the microphone is open, reports each wait as it begins. */
  openSession: (onStage: (stage: VoiceStartStage) => void) => Promise<Session>;
  /** True when the member turned voice off or started again while this start was in flight. */
  isSuperseded: () => boolean;
  keepSession: (session: Session) => void;
  setPhase: (phase: VoicePhase) => void;
  setStage: (stage: VoiceStartStage) => void;
  setNote: (note: string | null) => void;
  speak: (text: string) => void;
}

/** What a finished start leads to: nothing (superseded), an error, or really listening with the cue to speak. */
export type VoiceStartResolution =
  | { kind: "discard" }
  | { kind: "failed"; note: string }
  | { kind: "listening"; cue: string };

export function voiceStartResolution(finished: {
  superseded: boolean;
  failure: { error: unknown } | null;
}): VoiceStartResolution {
  if (finished.superseded) {
    return { kind: "discard" };
  }
  if (finished.failure) {
    const { error } = finished.failure;
    return { kind: "failed", note: error instanceof Error ? error.message : "Voice failed to start" };
  }
  return { kind: "listening", cue: LISTENING_CUE };
}

/**
 * Runs one voice start. The phase becomes "listening", and the cue is spoken,
 * only after the model is loaded and the microphone is open and the start is
 * still wanted; a refused permission, a failed load, or a superseded start
 * never says it is listening.
 */
export async function runVoiceStart<Session extends { stop: () => Promise<void> }>(
  dependencies: VoiceStartDependencies<Session>,
): Promise<void> {
  dependencies.setPhase("loading");
  dependencies.setStage("loadingModel");
  dependencies.setNote(null);
  let session: Session;
  try {
    session = await dependencies.openSession(dependencies.setStage);
  } catch (error) {
    dependencies.setStage("loadingModel");
    const resolution = voiceStartResolution({
      superseded: dependencies.isSuperseded(),
      failure: { error },
    });
    if (resolution.kind === "failed") {
      dependencies.setPhase("error");
      dependencies.setNote(resolution.note);
    }
    return;
  }
  dependencies.setStage("loadingModel");
  const resolution = voiceStartResolution({
    superseded: dependencies.isSuperseded(),
    failure: null,
  });
  if (resolution.kind === "discard") {
    await session.stop();
    return;
  }
  if (resolution.kind === "listening") {
    dependencies.keepSession(session);
    dependencies.setPhase("listening");
    dependencies.speak(resolution.cue);
  }
}
