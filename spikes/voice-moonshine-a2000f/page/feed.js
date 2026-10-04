import { ModelArch, Transcriber } from "/pkg/index.js";

const query = new URLSearchParams(location.search);
const architectureName = query.get("arch") ?? "TinyStreaming";
const loops = Number(query.get("loops") ?? 1);
const fixtureMode = query.get("fixture") ?? "speech";
const threadOverride = query.get("threads");
const nativeThreads = query.get("nativeThreads");
const nativeSpinning = query.get("nativeSpinning");
const nativeOptions = {};
if (nativeThreads) nativeOptions.ort_intra_op_threads = nativeThreads;
if (nativeSpinning) nativeOptions.ort_allow_spinning = nativeSpinning;
if (threadOverride) {
  Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => Number(threadOverride) });
}
const keyterms = query.get("keyterms") === "off" ? [] : ["Ada", "Grace", "develop", "behave", "Moonshine", "blue seven"];
const state = {
  crossOriginIsolated: self.crossOriginIsolated,
  userAgent: navigator.userAgent,
  architecture: architectureName,
  hardwareConcurrency: navigator.hardwareConcurrency,
  nativeOptions,
  keyterms,
  phase: "starting",
  errors: [],
};
window.voiceSpike = state;

function decodeWave(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let offset = 12;
  while (String.fromCharCode(...new Uint8Array(arrayBuffer, offset, 4)) !== "data") {
    offset += 8 + view.getUint32(offset + 4, true);
  }
  const sampleCount = view.getUint32(offset + 4, true) / 2;
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(offset + 8 + index * 2, true) / 32768;
  }
  return samples;
}

async function run() {
  const [waveBuffer, script] = await Promise.all([
    fetch("/fixtures/utterances.wav").then((response) => response.arrayBuffer()),
    fetch("/fixtures/utterances.json").then((response) => response.json()),
  ]);
  const decodedSamples = decodeWave(waveBuffer);
  const fixtureSamples = fixtureMode === "silence" ? new Float32Array(decodedSamples.length) : decodedSamples;
  if (fixtureMode === "idle") {
    state.phase = "feeding";
    const idleStartedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, (decodedSamples.length / 16000) * 1000 * loops));
    state.result = { wallSeconds: (performance.now() - idleStartedAt) / 1000, lines: [] };
    state.phase = "done";
    return;
  }
  state.phase = "loading";
  const loadStarted = performance.now();
  const transcriber = await Transcriber.load({
    language: "en",
    modelArch: ModelArch[architectureName],
    options: Object.keys(nativeOptions).length ? nativeOptions : undefined,
  });
  state.loadSeconds = (performance.now() - loadStarted) / 1000;
  if (keyterms.length > 0) transcriber.setKeyterms(keyterms);
  const stream = transcriber.createStream();
  const lines = [];
  const passDurations = [];
  let busyMilliseconds = 0;
  let maximumTimerGapMilliseconds = 0;
  const totalSamples = fixtureSamples.length * loops;
  const startedAt = performance.now();
  stream.addListener({
    onLineCompleted: (event) => lines.push({ text: event.line.text, atSeconds: (performance.now() - startedAt) / 1000 }),
  });
  stream.start();
  state.phase = "feeding";
  let fedSamples = 0;
  let lastTick = startedAt;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const now = performance.now();
      maximumTimerGapMilliseconds = Math.max(maximumTimerGapMilliseconds, now - lastTick);
      lastTick = now;
      const targetSamples = Math.min(totalSamples, Math.floor(((now - startedAt) / 1000) * 16000));
      const workStarted = performance.now();
      while (fedSamples < targetSamples) {
        const positionInFixture = fedSamples % fixtureSamples.length;
        const take = Math.min(targetSamples - fedSamples, fixtureSamples.length - positionInFixture);
        stream.addAudio(fixtureSamples.subarray(positionInFixture, positionInFixture + take), 16000);
        fedSamples += take;
      }
      const passStarted = performance.now();
      stream.transcribe();
      const passMilliseconds = performance.now() - passStarted;
      if (passMilliseconds > 1) passDurations.push(passMilliseconds);
      busyMilliseconds += performance.now() - workStarted;
      state.progress = fedSamples / totalSamples;
      if (fedSamples >= totalSamples) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
  stream.stop();
  const wallSeconds = (performance.now() - startedAt) / 1000;
  const fixtureSeconds = fixtureSamples.length / 16000;
  passDurations.sort((left, right) => left - right);
  const percentile = (fraction) => Math.round(passDurations[Math.floor(passDurations.length * fraction)] ?? 0);
  state.result = {
    wallSeconds,
    computeBusyPercentOfOneThread: Math.round((1000 * busyMilliseconds) / 1000 / wallSeconds) / 10,
    passCount: passDurations.length,
    passP50Ms: percentile(0.5),
    passP95Ms: percentile(0.95),
    passMaxMs: Math.round(passDurations.at(-1) ?? 0),
    maximumTimerGapMs: Math.round(maximumTimerGapMilliseconds),
    lines: lines.map((line) => {
      const positionInLoop = line.atSeconds % fixtureSeconds;
      const spoken = script.utterances.filter((utterance) => utterance.end <= positionInLoop + 0.5).at(-1);
      return {
        heard: line.text,
        expected: spoken?.text ?? null,
        secondsAfterSpeechEnded: spoken ? Math.round((positionInLoop - spoken.end) * 100) / 100 : null,
      };
    }),
  };
  state.phase = "done";
}

run().catch((error) => {
  state.errors.push(String(error?.stack ?? error));
  state.phase = "failed";
});
