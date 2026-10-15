const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const architectureSelect = document.getElementById("arch");
const threadsInput = document.getElementById("threads");
const teammatesInput = document.getElementById("teammates");
const statusElement = document.getElementById("status");
const partialElement = document.getElementById("partial");
const linesElement = document.getElementById("lines");

const localCommands = [
  { phrases: ["stop listening"], effect: "Turn the microphone off. No cloud call." },
  { phrases: ["repeat that", "read it", "say that again"], effect: "Re-speak the last reply. No cloud call." },
  { phrases: ["quiet", "skip"], effect: "Stop speaking the reply. No cloud call." },
  { phrases: ["stop", "cancel the turn"], effect: "Cancel the running turn. One POST, no model." },
  { phrases: ["status", "what's running", "whats running"], effect: "Read out turn and task status. One GET, no model." },
  { phrases: ["send", "send it"], effect: "Send the dictated draft as one ordinary turn." },
  { phrases: ["scratch that"], effect: "Clear the dictated draft. No cloud call." },
  { phrases: ["deny", "reject"], effect: "Deny the pending request. One POST, no model." },
];

const levelElement = document.getElementById("level");
const diagnosticsElement = document.getElementById("diagnostics");
const counters = { partials: 0, lines: 0, peakLevel: 0 };
let meterStream;
let meterContext;

function renderDiagnostics() {
  const context = microphone?.audioContext ?? meterContext;
  const track = microphone?.mediaStream?.getAudioTracks()[0] ?? meterStream?.getAudioTracks()[0];
  diagnosticsElement.textContent = [
    `isolated: ${self.crossOriginIsolated}`,
    `audio: ${context ? `${context.state} @ ${context.sampleRate} Hz` : "none"}`,
    `mic: ${track ? `${track.label || "unnamed"}${track.muted ? " (muted by the OS)" : ""}` : "none"}`,
    `peak level: ${counters.peakLevel.toFixed(3)}`,
    `partials: ${counters.partials}`,
    `lines: ${counters.lines}`,
  ].join("  |  ");
}

async function startMeter() {
  meterStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  meterContext = new AudioContext();
  await meterContext.resume();
  const analyser = meterContext.createAnalyser();
  analyser.fftSize = 1024;
  meterContext.createMediaStreamSource(meterStream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!meterContext) return;
    analyser.getFloatTimeDomainData(samples);
    let sumOfSquares = 0;
    for (const sample of samples) sumOfSquares += sample * sample;
    const rootMeanSquare = Math.sqrt(sumOfSquares / samples.length);
    counters.peakLevel = Math.max(counters.peakLevel, rootMeanSquare);
    levelElement.style.width = `${Math.min(100, rootMeanSquare * 400)}%`;
    renderDiagnostics();
    requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  meterStream?.getTracks().forEach((track) => track.stop());
  meterContext?.close();
  meterContext = undefined;
  levelElement.style.width = "0%";
}

window.addEventListener("error", (event) => setStatus(`Page error: ${event.message}`, true));
window.addEventListener("unhandledrejection", (event) => setStatus(`Unhandled error: ${event.reason?.message ?? event.reason}`, true));

let microphone;
let loadedThreadCount;
let listeningStartedAt;

function setStatus(text, warning = false) {
  statusElement.textContent = text;
  statusElement.classList.toggle("warning", warning);
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function soundex(word) {
  const codes = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  const letters = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!letters) return "";
  let result = letters[0].toUpperCase();
  let previous = codes[letters[0]] ?? 0;
  for (const letter of letters.slice(1)) {
    const code = codes[letter] ?? 0;
    if (code && code !== previous) result += code;
    if (letter !== "h" && letter !== "w") previous = code;
  }
  return (result + "000").slice(0, 4);
}

function teammateNames() {
  return teammatesInput.value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function matchTeammate(word, spokenAsAddress) {
  for (const name of teammateNames()) {
    if (normalize(name) === word) return { name, how: "exact" };
  }
  if (!spokenAsAddress) return null;
  for (const name of teammateNames()) {
    if (soundex(name) === soundex(word)) return { name, how: `sounds like "${word}"` };
  }
  return null;
}

function classify(text) {
  const normalized = normalize(text);
  if (!normalized) return { kind: "discarded", detail: "Empty line" };
  const command = localCommands
    .flatMap((entry) => entry.phrases.map((phrase) => ({ phrase, effect: entry.effect })))
    .sort((left, right) => right.phrase.length - left.phrase.length)
    .find(({ phrase }) => normalized === phrase || normalized === `${phrase} please`);
  if (command) return { kind: "local", detail: command.effect };
  const option = normalized.match(/^option (\d+|one|two|three|four|five)$/);
  if (option) {
    return { kind: "local", detail: `Choose option ${option[1]} on the pending request. One POST, no model.` };
  }
  const approval = normalized.match(/^approve ([a-z]+ [a-z]+)$/);
  if (approval) {
    return { kind: "local", detail: `Answer the pending request with code "${approval[1]}". One POST, no model.` };
  }
  const switchMatch = normalized.match(/^(?:switch to|talk to) (\S+)$/);
  if (switchMatch) {
    const teammate = matchTeammate(switchMatch[1], true);
    if (teammate) return { kind: "local", detail: `Select ${teammate.name} (${teammate.how}). No cloud call.` };
  }
  const [firstWord, ...rest] = normalized.split(" ");
  const spokenAsAddress = /^\s*[\p{L}']+\s*,/u.test(text);
  const teammate = matchTeammate(firstWord, spokenAsAddress);
  if (teammate && rest.length > 0) {
    return { kind: "sent", detail: `Would post to ${teammate.name} (${teammate.how}): one ordinary turn.` };
  }
  return { kind: "discarded", detail: "Not addressed to a teammate. Never leaves the tab." };
}

function appendLine(line) {
  const classification = classify(line.text);
  const item = document.createElement("li");
  item.className = classification.kind;
  const label = { sent: "Sent", local: "Local command", discarded: "Discarded" }[classification.kind];
  const secondsAfterStart = ((performance.now() - listeningStartedAt) / 1000).toFixed(1);
  item.innerHTML = `<span class="tag ${classification.kind}"></span><span class="heard"></span><span class="detail"></span>`;
  item.querySelector(".tag").textContent = label;
  item.querySelector(".heard").textContent = line.text;
  item.querySelector(".detail").textContent =
    `${classification.detail} Decoder ${Math.round(line.lastTranscriptionLatencyMs)} ms, at ${secondsAfterStart} s.`;
  linesElement.prepend(item);
  if (normalize(line.text) === "stop listening") stopListening();
}

async function startListening() {
  const threadCount = Number(threadsInput.value);
  if (!self.crossOriginIsolated) {
    setStatus("This page is not cross-origin isolated, so the threaded build cannot load. Serve it with COOP/COEP.", true);
    return;
  }
  if (loadedThreadCount !== undefined && loadedThreadCount !== threadCount) {
    setStatus(`The thread pool was already started with ${loadedThreadCount}. Reload the page to change it.`, true);
    return;
  }
  if (loadedThreadCount === undefined) {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => threadCount });
    loadedThreadCount = threadCount;
  }
  startButton.disabled = true;
  architectureSelect.disabled = true;
  threadsInput.disabled = true;
  let moonshine;
  try {
    moonshine = await import("/pkg/index.js");
  } catch (error) {
    setStatus(`Could not load Moonshine: ${error.message ?? error}`, true);
    startButton.disabled = false;
    return;
  }
  const { MicTranscriber, ModelArch } = moonshine;
  microphone = new MicTranscriber()
    .language("en")
    .modelArch(ModelArch[architectureSelect.value])
    .onProgress((fraction) => setStatus(`Downloading model: ${Math.round(fraction * 100)}%`))
    .onText((text) => {
      counters.partials += 1;
      partialElement.textContent = text;
    })
    .onLine((line) => {
      counters.lines += 1;
      partialElement.textContent = "";
      appendLine(line);
    })
    .onError((error) => setStatus(`Error: ${error.message ?? error}`, true));
  try {
    setStatus("Loading model...");
    await microphone.load();
    setStatus("Model loaded. Opening the microphone...");
    microphone.setKeyterms([...teammateNames(), "develop", "behave", "Moonshine", "Kanbus", "maple", "falcon"]);
    await microphone.start();
    listeningStartedAt = performance.now();
    stopButton.disabled = false;
    startMeter().catch((error) => setStatus(`Level meter unavailable: ${error.message ?? error}`, true));
    setStatus(`Listening with ${architectureSelect.value} on ${threadCount} threads. Speak normally; lines complete after a short pause.`);
  } catch (error) {
    setStatus(`Could not start: ${error.message ?? error}`, true);
    startButton.disabled = false;
  }
}

async function stopListening() {
  if (!microphone) return;
  stopMeter();
  await microphone.stop();
  microphone.close();
  microphone = undefined;
  partialElement.textContent = "";
  stopButton.disabled = true;
  startButton.disabled = false;
  setStatus("Stopped. Start again to keep listening; the model stays cached.");
}

startButton.addEventListener("click", startListening);
stopButton.addEventListener("click", stopListening);
if (!self.crossOriginIsolated) {
  setStatus("Not cross-origin isolated: open this page from the spike server.", true);
}
window.voiceDemo = { classify };
