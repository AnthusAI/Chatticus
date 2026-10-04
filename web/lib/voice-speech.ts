/**
 * Spoken replies through the browser's built-in speech synthesis. No model
 * download and no cost; the voice is whatever the device provides.
 *
 * Text is spoken one sentence per utterance: Chrome cuts long utterances off
 * after about 15 seconds and can drop an utterance's end event, so only the
 * current speech is tracked and a watchdog ends it if the engine goes quiet.
 */

const WATCHDOG_INTERVAL_MS = 500;

export interface SpeechHandlers {
  onStart: () => void;
  onEnd: () => void;
}

let currentSpeech = 0;
let watchdog: number | undefined;

export function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * iOS only lets a page speak after speech has started inside a user gesture,
 * so the tap that starts listening speaks a silent space.
 */
export function unlockSpeech(): void {
  if (!isSpeechAvailable()) {
    return;
  }
  const silent = new SpeechSynthesisUtterance(" ");
  silent.volume = 0;
  window.speechSynthesis.speak(silent);
}

function clearWatchdog(): void {
  if (watchdog !== undefined) {
    window.clearInterval(watchdog);
    watchdog = undefined;
  }
}

/** Speaks ``text``, replacing anything already being spoken; false when nothing will be said. */
export function speak(text: string, handlers: SpeechHandlers): boolean {
  if (!isSpeechAvailable() || !text.trim()) {
    return false;
  }
  const speech = (currentSpeech += 1);
  clearWatchdog();
  window.speechSynthesis.cancel();
  const sentences = text.split(/(?<=[.!?…])\s+/).filter((sentence) => sentence.trim());
  let ended = false;
  const finish = () => {
    if (ended || speech !== currentSpeech) {
      return;
    }
    ended = true;
    clearWatchdog();
    handlers.onEnd();
  };
  sentences.forEach((sentence, index) => {
    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.lang = "en-US";
    if (index === 0) {
      utterance.onstart = () => {
        if (speech === currentSpeech) handlers.onStart();
      };
    }
    if (index === sentences.length - 1) {
      utterance.onend = finish;
    }
    utterance.onerror = () => {
      if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        finish();
      }
    };
    window.speechSynthesis.speak(utterance);
  });
  watchdog = window.setInterval(() => {
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      finish();
    }
  }, WATCHDOG_INTERVAL_MS);
  return true;
}

export function stopSpeaking(): void {
  currentSpeech += 1;
  clearWatchdog();
  if (isSpeechAvailable()) {
    window.speechSynthesis.cancel();
  }
}
