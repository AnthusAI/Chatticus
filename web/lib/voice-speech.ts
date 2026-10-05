/**
 * Spoken replies through the browser's built-in speech synthesis. No model
 * download and no cost; the voice is whatever the device provides.
 *
 * Text is spoken one sentence per utterance: Chrome cuts long utterances off
 * after about 15 seconds and can drop an utterance's end event, so only the
 * current speech is tracked and a watchdog ends it if the engine goes quiet.
 */

const WATCHDOG_INTERVAL_MS = 500;
const SPEAK_AFTER_CANCEL_MS = 80;

const START_GRACE_MS = 4_000;

const DEADLINE_BASE_MS = 4_000;
const DEADLINE_PER_CHARACTER_MS = 120;

/** The longest a spoken text is trusted to take; past it the engine is assumed to have gone quiet. */
export function speechDeadlineMs(text: string): number {
  return DEADLINE_BASE_MS + text.length * DEADLINE_PER_CHARACTER_MS;
}

/** How long past its expected end a reply may report itself still speaking while the engine is idle. */
export const STUCK_SPEECH_GRACE_MS = 1_000;

/**
 * Whether the speaking state is stale: the reply is flagged as speaking, its
 * expected end has passed by more than the grace period, and the engine has
 * nothing playing or queued.
 */
export function speakingStateIsStuck(state: {
  speakingFlag: boolean;
  millisecondsPastExpectedEnd: number;
  engineBusy: boolean;
}): boolean {
  return (
    state.speakingFlag &&
    !state.engineBusy &&
    state.millisecondsPastExpectedEnd > STUCK_SPEECH_GRACE_MS
  );
}

/**
 * Whether a heard line may be the browser hearing its own reply. A speaking
 * flag that is stuck never counts, so a stale flag cannot discard later lines.
 */
export function lineMayBeOwnSpeech(state: {
  overlapsSpeechWindow: boolean;
  speakingFlag: boolean;
  speakingStateStuck: boolean;
}): boolean {
  return state.overlapsSpeechWindow || (state.speakingFlag && !state.speakingStateStuck);
}

/** Why a spoken reply ended: ``finished`` is the only normal one; the rest name the path that cut it short. */
export type SpeechEndReason = "finished" | string;

/** The note shown when speech ended early, or null when it finished on its own. */
export function speechEndNote(reason: SpeechEndReason): string | null {
  return reason === "finished" ? null : `Speech stopped: ${reason}`;
}

/**
 * Whether the watchdog may declare speech over. Some engines (iOS) report
 * neither speaking nor pending for a moment after speak(), so before the
 * first utterance has started the watchdog waits out a grace period.
 */
export function speechWatchdogShouldEnd(state: {
  started: boolean;
  millisecondsSinceQueued: number;
  engineBusy: boolean;
}): boolean {
  if (state.engineBusy) {
    return false;
  }
  return state.started || state.millisecondsSinceQueued >= START_GRACE_MS;
}

export interface SpeechHandlers {
  onStart: () => void;
  onEnd: (reason: SpeechEndReason) => void;
  onReplaced?: () => void;
  onError?: (error: string) => void;
}

let currentSpeech = 0;
let watchdog: number | undefined;
let deadline: number | undefined;
let activeHandlers: SpeechHandlers | undefined;
let activeSpeechUnfinished = false;

export function isSpeechEngineBusy(): boolean {
  return (
    isSpeechAvailable() && (window.speechSynthesis.speaking || window.speechSynthesis.pending)
  );
}

export function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function clearWatchdog(): void {
  if (watchdog !== undefined) {
    window.clearInterval(watchdog);
    watchdog = undefined;
  }
  if (deadline !== undefined) {
    window.clearTimeout(deadline);
    deadline = undefined;
  }
}

/** Speaks ``text``, replacing anything already being spoken; false when nothing will be said. */
export function speak(text: string, handlers: SpeechHandlers): boolean {
  if (!isSpeechAvailable() || !text.trim()) {
    return false;
  }
  const speech = (currentSpeech += 1);
  if (activeSpeechUnfinished) {
    activeHandlers?.onReplaced?.();
  }
  activeHandlers = handlers;
  activeSpeechUnfinished = true;
  clearWatchdog();
  const mustCancel = window.speechSynthesis.speaking || window.speechSynthesis.pending;
  if (mustCancel) {
    window.speechSynthesis.cancel();
  }
  const sentences = text.split(/(?<=[.!?…])\s+/).filter((sentence) => sentence.trim());
  let ended = false;
  let started = false;
  let queuedAt = Date.now();
  const finish = (reason: SpeechEndReason) => {
    if (ended || speech !== currentSpeech) {
      return;
    }
    ended = true;
    activeSpeechUnfinished = false;
    clearWatchdog();
    handlers.onEnd(reason);
  };
  const queueSentences = () => {
    if (speech !== currentSpeech) {
      return;
    }
    queuedAt = Date.now();
    sentences.forEach((sentence, index) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = "en-US";
      if (index === 0) {
        utterance.onstart = () => {
          if (speech === currentSpeech) {
            started = true;
            handlers.onStart();
          }
        };
      }
      if (index === sentences.length - 1) {
        utterance.onend = () => finish("finished");
      }
      utterance.onerror = (event) => {
        if (event.error !== "canceled" && event.error !== "interrupted") {
          handlers.onError?.(event.error);
        }
        if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
          finish(`engine reported ${event.error}`);
        }
      };
      window.speechSynthesis.speak(utterance);
    });
    watchdog = window.setInterval(() => {
      const engineBusy = window.speechSynthesis.speaking || window.speechSynthesis.pending;
      if (
        speechWatchdogShouldEnd({
          started,
          millisecondsSinceQueued: Date.now() - queuedAt,
          engineBusy,
        })
      ) {
        finish("watchdog: the engine went quiet");
      }
    }, WATCHDOG_INTERVAL_MS);
    deadline = window.setTimeout(() => {
      if (speech === currentSpeech) {
        window.speechSynthesis.cancel();
        finish("deadline: the reply ran past its expected length");
      }
    }, speechDeadlineMs(text));
  };
  if (mustCancel) {
    window.setTimeout(queueSentences, SPEAK_AFTER_CANCEL_MS);
  } else {
    queueSentences();
  }
  return true;
}

export function stopSpeaking(): void {
  currentSpeech += 1;
  activeSpeechUnfinished = false;
  clearWatchdog();
  if (isSpeechAvailable()) {
    window.speechSynthesis.cancel();
  }
}
