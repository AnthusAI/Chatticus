import type { CaptureRestoreOutcome } from "./voice-control";

export interface CaptureWatchDependencies {
  isStopped: () => boolean;
  /** True while a reply is spoken; recovery would reclaim the audio session and cut it off. */
  isSpeaking: () => boolean;
  /** What is wrong with capture right now, or null when it is healthy. */
  problem: () => string | null;
  restore: () => Promise<CaptureRestoreOutcome>;
  report: (outcome: CaptureRestoreOutcome) => void;
}

export interface CaptureWatch {
  /** One look at capture; takes no recovery action while speech plays. */
  check: () => void;
  /** Speech ended by any path: run the check once immediately. */
  speechEnded: () => void;
  /** Records the outcome of a tap, so the watch knows whether a tap is still needed. */
  recordOutcome: (outcome: CaptureRestoreOutcome) => void;
}

export function createCaptureWatch(dependencies: CaptureWatchDependencies): CaptureWatch {
  let needsTap = false;
  let recovering = false;
  const check = () => {
    if (dependencies.isStopped() || needsTap || recovering || dependencies.isSpeaking()) return;
    if (dependencies.problem() === null) return;
    recovering = true;
    void dependencies
      .restore()
      .then((outcome) => {
        needsTap = outcome.kind === "needsTap";
        if (!dependencies.isStopped()) dependencies.report(outcome);
      })
      .finally(() => {
        recovering = false;
      });
  };
  return {
    check,
    speechEnded: check,
    recordOutcome: (outcome) => {
      needsTap = outcome.kind === "needsTap";
    },
  };
}
