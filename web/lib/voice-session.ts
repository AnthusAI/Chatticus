import type { MicTranscriber } from "@moonshine-ai/moonshine-wasm";

import { lineStartedAtMs } from "./voice-control";

/** Must match the exact `@moonshine-ai/moonshine-wasm` version in package.json. */
export const MOONSHINE_VERSION = "0.1.5";

/**
 * Threads the speech-to-text model runs on. The published WASM build starts
 * one worker per core and its idle workers spin; two keeps latency and uses a
 * fraction of the CPU (docs/VOICE.md, Spike results). Until Moonshine exposes
 * a setting (chatticus-070c91) the pool is sized by presenting this as the
 * core count while the module starts.
 */
export const VOICE_THREAD_COUNT = 2;

export interface VoiceSessionHandlers {
  onPartial: (text: string) => void;
  /** A completed line, with the wall-clock time (ms) its speech began. */
  onLine: (text: string, startedAtMs: number) => void;
  onProgress: (fraction: number) => void;
  /** Trouble with one recognition pass; capture continues. */
  onRecognizerTrouble: (error: Error) => void;
  /** Capture can no longer continue: the microphone track ended or the audio engine closed. */
  onMicrophoneLost: (reason: string) => void;
}

export interface VoiceSession {
  setKeyterms: (keyterms: string[]) => void;
  stop: () => Promise<void>;
  /**
   * Wakes the audio engine if the system suspended or interrupted it, as iOS
   * does around speech. Resolves true when it had to be woken.
   */
  resumeCapture: () => Promise<boolean>;
}

interface CaptureInternals {
  mediaStream?: MediaStream;
  audioContext?: AudioContext;
}

function captureInternals(microphone: MicTranscriber): CaptureInternals {
  return microphone as unknown as CaptureInternals;
}

async function releaseCapture(microphone: MicTranscriber): Promise<void> {
  const { mediaStream, audioContext } = captureInternals(microphone);
  try {
    await microphone.stop();
  } catch {
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => undefined);
    }
  }
  mediaStream?.getTracks().forEach((track) => track.stop());
  try {
    microphone.close();
  } catch {
    return;
  }
}

type MoonshineModule = typeof import("@moonshine-ai/moonshine-wasm");

let moonshineModule: Promise<MoonshineModule> | undefined;

export function moonshineBaseUrl(): string {
  return `/vendor/moonshine/${MOONSHINE_VERSION}/`;
}

function loadMoonshine(): Promise<MoonshineModule> {
  moonshineModule ??= import(/* webpackIgnore: true */ `${moonshineBaseUrl()}index.js`).catch(
    (error: unknown) => {
      moonshineModule = undefined;
      throw error;
    },
  ) as Promise<MoonshineModule>;
  return moonshineModule;
}

async function withPresentedCoreCount<Result>(
  coreCount: number,
  work: () => Promise<Result>,
): Promise<Result> {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    get: () => coreCount,
  });
  try {
    return await work();
  } finally {
    delete (navigator as { hardwareConcurrency?: number }).hardwareConcurrency;
  }
}

export async function startVoiceSession(
  handlers: VoiceSessionHandlers,
  keyterms: string[],
): Promise<VoiceSession> {
  const microphone: MicTranscriber = await withPresentedCoreCount(VOICE_THREAD_COUNT, async () => {
    const { MicTranscriber, ModelArch } = await loadMoonshine();
    const loaded = new MicTranscriber()
      .language("en")
      .modelArch(ModelArch.TinyStreaming)
      .onProgress((fraction) => handlers.onProgress(fraction))
      .onText((text) => handlers.onPartial(text))
      .onLine((line) => handlers.onLine(line.text, lineStartedAtMs(Date.now(), line.duration)))
      .onError((error) => handlers.onRecognizerTrouble(error));
    await loaded.load();
    return loaded;
  });
  try {
    if (keyterms.length > 0) {
      microphone.setKeyterms(keyterms);
    }
    await microphone.start();
  } catch (error) {
    await releaseCapture(microphone);
    throw error;
  }
  let stopped = false;
  const { mediaStream, audioContext } = captureInternals(microphone);
  const resumeCapture = async (): Promise<boolean> => {
    if (stopped) {
      return false;
    }
    if (mediaStream?.getAudioTracks().some((track) => track.readyState === "ended")) {
      handlers.onMicrophoneLost("The microphone stopped. Start the voice conversation again.");
      return false;
    }
    if (audioContext && audioContext.state !== "running" && audioContext.state !== "closed") {
      await audioContext.resume().catch(() => undefined);
      return true;
    }
    return false;
  };
  mediaStream?.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (!stopped) {
        handlers.onMicrophoneLost("The microphone stopped. Start the voice conversation again.");
      }
    });
  });
  audioContext?.addEventListener("statechange", () => {
    if (stopped) return;
    if (audioContext.state === "closed") {
      handlers.onMicrophoneLost("The audio engine stopped. Start the voice conversation again.");
    } else {
      void resumeCapture();
    }
  });
  return {
    setKeyterms: (nextKeyterms) => microphone.setKeyterms(nextKeyterms),
    resumeCapture,
    stop: async () => {
      stopped = true;
      await releaseCapture(microphone);
    },
  };
}
