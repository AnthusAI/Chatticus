import type { MicTranscriber } from "@moonshine-ai/moonshine-wasm";

import { restoreCapture } from "./voice-capture-restore";
import {
  captureWatchProblem,
  lineStartedAtMs,
  type CaptureRestoreOutcome,
} from "./voice-control";

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
  /** Capture stopped delivering audio and was restored, rebuilt, or needs a tap (call `restoreCapture` from one). */
  onCaptureRestored: (outcome: CaptureRestoreOutcome) => void;
}

export interface VoiceSession {
  setKeyterms: (keyterms: string[]) => void;
  stop: () => Promise<void>;
  /**
   * Brings capture back and proves it is listening: the engine runs, a track
   * is live and unmuted, and audio is arriving. If not, capture is rebuilt
   * from a fresh microphone stream, reusing the loaded model; if the browser
   * refuses, the outcome asks for a tap (call this again from one). Capture is
   * also watched continuously and restored on its own when audio stops
   * arriving, whether or not the device is speaking.
   */
  restoreCapture: () => Promise<CaptureRestoreOutcome>;
}

interface RecognizerStreamInternals {
  addAudio: (...audio: unknown[]) => unknown;
}

interface CaptureInternals {
  mediaStream?: MediaStream;
  audioContext?: AudioContext;
  stream?: RecognizerStreamInternals;
  transcriber?: { close: () => void };
  ownsTranscriber?: boolean;
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

const CAPTURE_WATCH_INTERVAL_MS = 500;

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function configureMicrophone(
  MicTranscriberClass: MoonshineModule["MicTranscriber"],
  handlers: VoiceSessionHandlers,
): MicTranscriber {
  return new MicTranscriberClass()
    .language("en")
    .onText((text) => handlers.onPartial(text))
    .onLine((line) => handlers.onLine(line.text, lineStartedAtMs(Date.now(), line.duration)))
    .onError((error) => handlers.onRecognizerTrouble(error));
}

export async function startVoiceSession(
  handlers: VoiceSessionHandlers,
  keyterms: string[],
): Promise<VoiceSession> {
  const { MicTranscriber: MicTranscriberClass, ModelArch } = await loadMoonshine();
  const firstMicrophone: MicTranscriber = await withPresentedCoreCount(
    VOICE_THREAD_COUNT,
    async () => {
      const loaded = configureMicrophone(MicTranscriberClass, handlers)
        .modelArch(ModelArch.TinyStreaming)
        .onProgress((fraction) => handlers.onProgress(fraction));
      await loaded.load();
      return loaded;
    },
  );
  const loadedTranscriber = captureInternals(firstMicrophone).transcriber;
  captureInternals(firstMicrophone).ownsTranscriber = false;
  const releaseModel = () => loadedTranscriber?.close();
  try {
    if (keyterms.length > 0) {
      firstMicrophone.setKeyterms(keyterms);
    }
    await firstMicrophone.start();
  } catch (error) {
    await releaseCapture(firstMicrophone);
    releaseModel();
    throw error;
  }
  let microphone = firstMicrophone;
  let stopped = false;
  let framesDelivered = 0;
  let framesCountable = false;
  let lastFrameAtMs = Date.now();
  let needsTap = false;
  let restoring: Promise<CaptureRestoreOutcome> | undefined;

  const attachCapture = () => {
    framesDelivered = 0;
    lastFrameAtMs = Date.now();
    const { stream } = captureInternals(microphone);
    framesCountable = Boolean(stream);
    if (stream) {
      const deliverAudio = stream.addAudio.bind(stream);
      stream.addAudio = (...audio) => {
        framesDelivered += 1;
        lastFrameAtMs = Date.now();
        return deliverAudio(...audio);
      };
    }
  };
  attachCapture();

  const rebuildCapture = async () => {
    await releaseCapture(microphone);
    const fresh = configureMicrophone(MicTranscriberClass, handlers).useTranscriber(
      loadedTranscriber as unknown as Parameters<MicTranscriber["useTranscriber"]>[0],
    );
    try {
      await fresh.start();
    } catch (error) {
      await releaseCapture(fresh);
      throw error;
    }
    if (stopped) {
      await releaseCapture(fresh);
      throw new Error("The voice conversation was turned off.");
    }
    microphone = fresh;
    attachCapture();
  };

  const restoreCaptureOnce = () =>
    restoreCapture({
      resume: async () => {
        const { audioContext } = captureInternals(microphone);
        if (audioContext && audioContext.state !== "running" && audioContext.state !== "closed") {
          await audioContext.resume();
        }
      },
      snapshot: () => {
        const { mediaStream, audioContext } = captureInternals(microphone);
        return {
          engineState: audioContext?.state ?? "closed",
          tracks: (mediaStream?.getAudioTracks() ?? []).map((track) => ({
            readyState: track.readyState,
            muted: track.muted,
          })),
        };
      },
      frameCount: () => (framesCountable ? framesDelivered : null),
      rebuild: rebuildCapture,
      sleep: waitMilliseconds,
    });

  const restoreOnce = () => {
    if (stopped) {
      return Promise.resolve<CaptureRestoreOutcome>({
        kind: "needsTap",
        reason: "the voice conversation is off",
      });
    }
    restoring ??= restoreCaptureOnce().finally(() => {
      restoring = undefined;
      lastFrameAtMs = Date.now();
    });
    return restoring;
  };

  const watchdog = window.setInterval(() => {
    if (stopped || needsTap || restoring) return;
    const { mediaStream, audioContext } = captureInternals(microphone);
    const problem = captureWatchProblem({
      engineState: audioContext?.state ?? "closed",
      tracks: (mediaStream?.getAudioTracks() ?? []).map((track) => ({
        readyState: track.readyState,
        muted: track.muted,
      })),
      millisecondsSinceFrame: framesCountable ? Date.now() - lastFrameAtMs : 0,
    });
    if (problem === null) return;
    void restoreOnce().then((outcome) => {
      needsTap = outcome.kind === "needsTap";
      if (!stopped) handlers.onCaptureRestored(outcome);
    });
  }, CAPTURE_WATCH_INTERVAL_MS);

  return {
    setKeyterms: (nextKeyterms) => loadedTranscriber && microphone.setKeyterms(nextKeyterms),
    restoreCapture: async () => {
      const outcome = await restoreOnce();
      needsTap = outcome.kind === "needsTap";
      return outcome;
    },
    stop: async () => {
      stopped = true;
      window.clearInterval(watchdog);
      await releaseCapture(microphone);
      releaseModel();
    },
  };
}
