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

export interface SpeechHandlers {
  onStart: () => void;
  onEnd: () => void;
  onError?: (error: string) => void;
}

let currentSpeech = 0;
let watchdog: number | undefined;

export function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
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
  const mustCancel = window.speechSynthesis.speaking || window.speechSynthesis.pending;
  if (mustCancel) {
    window.speechSynthesis.cancel();
  }
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
  const queueSentences = () => {
    if (speech !== currentSpeech) {
      return;
    }
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
      utterance.onerror = (event) => {
        if (event.error !== "canceled" && event.error !== "interrupted") {
          handlers.onError?.(event.error);
        }
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
  clearWatchdog();
  if (isSpeechAvailable()) {
    window.speechSynthesis.cancel();
  }
}
