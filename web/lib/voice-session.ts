import type { MicTranscriber } from "@moonshine-ai/moonshine-wasm";

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
  onError: (error: Error) => void;
}

export interface VoiceSession {
  setKeyterms: (keyterms: string[]) => void;
  stop: () => Promise<void>;
}

type MoonshineModule = typeof import("@moonshine-ai/moonshine-wasm");

let moonshineModule: Promise<MoonshineModule> | undefined;

export function moonshineBaseUrl(): string {
  return `/vendor/moonshine/${MOONSHINE_VERSION}/`;
}

function loadMoonshine(): Promise<MoonshineModule> {
  moonshineModule ??= import(
    /* webpackIgnore: true */ `${moonshineBaseUrl()}index.js`
  ).catch((error: unknown) => {
    moonshineModule = undefined;
    throw error;
  }) as Promise<MoonshineModule>;
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
  let listeningStartedAt = Date.now();
  const microphone: MicTranscriber = await withPresentedCoreCount(VOICE_THREAD_COUNT, async () => {
    const { MicTranscriber, ModelArch } = await loadMoonshine();
    const loaded = new MicTranscriber()
      .language("en")
      .modelArch(ModelArch.TinyStreaming)
      .onProgress((fraction) => handlers.onProgress(fraction))
      .onText((text) => handlers.onPartial(text))
      .onLine((line) => handlers.onLine(line.text, listeningStartedAt + line.startTime * 1000))
      .onError((error) => handlers.onError(error));
    await loaded.load();
    return loaded;
  });
  try {
    if (keyterms.length > 0) {
      microphone.setKeyterms(keyterms);
    }
    await microphone.start();
    listeningStartedAt = Date.now();
  } catch (error) {
    microphone.close();
    throw error;
  }
  return {
    setKeyterms: (nextKeyterms) => microphone.setKeyterms(nextKeyterms),
    stop: async () => {
      await microphone.stop();
      microphone.close();
    },
  };
}
