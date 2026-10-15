import type { MicTranscriber } from "@moonshine-ai/moonshine-wasm";

import type { OpenedAudio } from "./voice-capture-restore";

const RECOGNIZER_SAMPLE_RATE = 16_000;

interface RecognizerStream {
  addListener: (listener: unknown) => void;
  start: () => void;
  addAudio: (...audio: unknown[]) => unknown;
  transcribe: (flags: unknown) => unknown;
}

interface StartableInternals {
  running: boolean;
  muted: boolean;
  flags: unknown;
  listeners: unknown[];
  mediaStream?: MediaStream;
  audioContext?: AudioContext;
  sourceNode?: MediaStreamAudioSourceNode;
  stream?: RecognizerStream;
  transcriber: { createStream: (options: { flags: unknown }) => RecognizerStream };
  namedCallbackListener: () => unknown;
  setupWorklet: (onChunk: (chunk: Float32Array) => void) => Promise<void>;
  setupScriptProcessor: (onChunk: (chunk: Float32Array) => void) => void;
}

function resampleToRecognizerRate(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === RECOGNIZER_SAMPLE_RATE) return input;
  const ratio = inputRate / RECOGNIZER_SAMPLE_RATE;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const base = Math.floor(position);
    const fraction = position - base;
    const first = input[base] ?? 0;
    const second = input[base + 1] ?? first;
    output[index] = first + (second - first) * fraction;
  }
  return output;
}

/**
 * Starts a loaded transcriber on a microphone stream and audio context that
 * were opened elsewhere (inside a tap), mirroring the library's own start but
 * without creating either, so no await separates the gesture from them.
 */
export async function startWithOpenedAudio(
  microphone: MicTranscriber,
  openedAudio: OpenedAudio,
): Promise<void> {
  const internals = microphone as unknown as StartableInternals;
  internals.running = true;
  internals.mediaStream = openedAudio.stream;
  internals.audioContext = openedAudio.audioContext;
  const inputSampleRate = openedAudio.audioContext.sampleRate;
  internals.sourceNode = openedAudio.audioContext.createMediaStreamSource(openedAudio.stream);
  const stream = internals.transcriber.createStream({ flags: internals.flags });
  internals.stream = stream;
  stream.addListener(internals.namedCallbackListener());
  internals.listeners.forEach((listener) => stream.addListener(listener));
  stream.start();
  const onChunk = (chunk: Float32Array) => {
    if (!internals.running || internals.muted || !internals.stream) return;
    internals.stream.addAudio(
      resampleToRecognizerRate(chunk, inputSampleRate),
      RECOGNIZER_SAMPLE_RATE,
      internals.flags,
    );
    internals.stream.transcribe(internals.flags);
  };
  if (openedAudio.audioContext.audioWorklet) {
    await internals.setupWorklet(onChunk);
  } else {
    internals.setupScriptProcessor(onChunk);
  }
}

export function discardOpenedAudio(openedAudio: OpenedAudio): void {
  openedAudio.stream.getTracks().forEach((track) => track.stop());
  if (openedAudio.audioContext.state !== "closed") {
    void openedAudio.audioContext.close().catch(() => undefined);
  }
}

/** Requests the microphone and creates and resumes an audio context, synchronously before any await. */
export function openAudioSynchronously(): Promise<OpenedAudio> {
  const streamRequest = navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new AudioContext();
  void audioContext.resume().catch(() => undefined);
  return streamRequest.then(
    (stream) => ({ stream, audioContext }),
    (error: unknown) => {
      void audioContext.close().catch(() => undefined);
      throw error;
    },
  );
}
