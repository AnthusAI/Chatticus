/**
 * Spoken replies through the browser's built-in speech synthesis. No model
 * download and no cost; the voice is whatever the device provides.
 */

export function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * iOS only lets a page speak after speech has started inside a user gesture,
 * so the tap that starts listening also speaks an empty utterance.
 */
export function unlockSpeech(): void {
  if (!isSpeechAvailable()) {
    return;
  }
  const silent = new SpeechSynthesisUtterance("");
  silent.volume = 0;
  window.speechSynthesis.speak(silent);
}

export interface SpeechHandlers {
  onStart: () => void;
  onEnd: () => void;
}

/** Speaks ``text``, replacing anything already being spoken. */
export function speak(text: string, handlers: SpeechHandlers): void {
  if (!isSpeechAvailable() || !text.trim()) {
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.onstart = () => handlers.onStart();
  utterance.onend = () => handlers.onEnd();
  utterance.onerror = () => handlers.onEnd();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (isSpeechAvailable()) {
    window.speechSynthesis.cancel();
  }
}
