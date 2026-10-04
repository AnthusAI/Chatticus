import { MicTranscriber, ModelArch } from "/pkg/index.js";

const query = new URLSearchParams(location.search);
const architectureName = query.get("arch") ?? "TinyStreaming";
const logElement = document.getElementById("log");
const state = {
  crossOriginIsolated: self.crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  userAgent: navigator.userAgent,
  architecture: architectureName,
  loadStartedAt: null,
  loadFinishedAt: null,
  listeningStartedAt: null,
  downloadedFiles: {},
  lines: [],
  partialCount: 0,
  errors: [],
};
window.voiceSpike = state;

function log(message) {
  logElement.textContent += `${message}\n`;
}

async function startListening() {
  const microphone = new MicTranscriber()
    .language("en")
    .modelArch(ModelArch[architectureName])
    .onProgress((fraction, file, progress) => {
      state.downloadedFiles[file] = progress?.loaded ?? null;
    })
    .onText(() => {
      state.partialCount += 1;
    })
    .onLine((line) => {
      const receivedAt = performance.now();
      state.lines.push({
        text: line.text,
        startTime: line.startTime,
        duration: line.duration,
        lastTranscriptionLatencyMs: line.lastTranscriptionLatencyMs,
        receivedAtMs: receivedAt - state.listeningStartedAt,
      });
      log(`[${((receivedAt - state.listeningStartedAt) / 1000).toFixed(2)}s] ${line.text}`);
    })
    .onError((error) => {
      state.errors.push(String(error?.message ?? error));
      log(`error: ${error?.message ?? error}`);
    });
  try {
    state.loadStartedAt = performance.now();
    await microphone.load();
    state.loadFinishedAt = performance.now();
    log(`loaded ${architectureName} in ${((state.loadFinishedAt - state.loadStartedAt) / 1000).toFixed(1)}s`);
    microphone.setKeyterms(["Ada", "Grace", "develop", "behave", "Moonshine"]);
    await microphone.start();
    state.listeningStartedAt = performance.now();
    log("listening");
  } catch (error) {
    state.errors.push(String(error?.stack ?? error));
    log(`error: ${error?.stack ?? error}`);
  }
}

log(`crossOriginIsolated=${state.crossOriginIsolated} SharedArrayBuffer=${state.sharedArrayBuffer}`);
document.getElementById("start").addEventListener("click", startListening);
if (query.get("autostart") === "1") {
  startListening();
}
