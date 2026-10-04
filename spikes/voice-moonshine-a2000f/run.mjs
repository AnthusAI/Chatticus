import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, webkit } from "playwright";

const engineName = process.env.VOICE_SPIKE_ENGINE ?? "chromium";
const architecture = process.env.VOICE_SPIKE_ARCH ?? "TinyStreaming";
const loops = Number(process.env.VOICE_SPIKE_LOOPS ?? 1);
const coep = process.env.VOICE_SPIKE_COEP ?? "require-corp";
const fixtureMode = process.env.VOICE_SPIKE_FIXTURE ?? "speech";
const threads = process.env.VOICE_SPIKE_THREADS ?? "";
const keytermsMode = process.env.VOICE_SPIKE_KEYTERMS ?? "on";
const port = 5200 + Math.floor(Math.random() * 500);

function processTreeUsage(rootProcessId) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, time]) => {
      const [clock, fraction = "0"] = time.split(".");
      const seconds = clock.split(":").map(Number).reduce((total, value) => total * 60 + value, 0);
      return { pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss), cpuSeconds: seconds + Number(`0.${fraction}`) };
    });
  const descendants = new Set([rootProcessId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        grew = true;
      }
    }
  }
  const tree = rows.filter((row) => descendants.has(row.pid) && row.pid !== rootProcessId);
  return {
    cpuSeconds: tree.reduce((total, row) => total + row.cpuSeconds, 0),
    rssMb: tree.reduce((total, row) => total + row.rssKb, 0) / 1024,
  };
}

const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, VOICE_SPIKE_PORT: String(port), VOICE_SPIKE_COEP: coep },
  stdio: ["ignore", "inherit", "inherit"],
});
await sleep(500);
const engine = engineName === "webkit" ? webkit : chromium;
const browser = await engine.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
page.on("pageerror", (error) => consoleErrors.push(String(error)));
await page.goto(`http://localhost:${port}/page/feed.html?arch=${architecture}&loops=${loops}&fixture=${fixtureMode}&threads=${threads}&keyterms=${keytermsMode}`);

let state;
let feedingBaseline;
let peakRssMb = 0;
const runStartedAt = Date.now();
for (;;) {
  await sleep(2000);
  state = await page.evaluate(() => ({ ...window.voiceSpike, result: undefined }));
  const usage = processTreeUsage(process.pid);
  peakRssMb = Math.max(peakRssMb, usage.rssMb);
  if (state.phase === "feeding" && !feedingBaseline) feedingBaseline = usage;
  console.log(`${engineName} ${state.phase} ${Math.round((state.progress ?? 0) * 100)}% rss=${Math.round(usage.rssMb)}MB`);
  if (state.phase === "done" || state.phase === "failed") break;
  if (state.phase !== "feeding" && Date.now() - runStartedAt > 120_000) {
    state.phase = "stalled";
    break;
  }
}
const finalUsage = processTreeUsage(process.pid);
const fullState = await page.evaluate(() => window.voiceSpike);
await browser.close();
server.kill();

const result = {
  engine: engineName,
  fixture: fixtureMode,
  threadPool: fullState.hardwareConcurrency,
  keyterms: fullState.keyterms,
  architecture,
  coep,
  loops,
  outcome: state.phase,
  crossOriginIsolated: fullState.crossOriginIsolated,
  userAgent: fullState.userAgent,
  loadSeconds: fullState.loadSeconds,
  errors: fullState.errors,
  consoleErrors,
  browserProcessTreeCpuPercentOfOneCore: fullState.result
    ? Math.round(((finalUsage.cpuSeconds - feedingBaseline.cpuSeconds) / fullState.result.wallSeconds) * 1000) / 10
    : null,
  peakBrowserProcessTreeRssMb: Math.round(peakRssMb),
  ...fullState.result,
};
const resultPath = `results/${engineName}-${fixtureMode}-${architecture}-${coep}-x${loops}-t${fullState.hardwareConcurrency}-k${keytermsMode}.json`;
writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, lines: undefined }, null, 2));
for (const line of result.lines ?? []) {
  console.log(`${String(line.secondsAfterSpeechEnded).padStart(6)}s  ${line.heard}`);
}
console.log(`wrote ${resultPath}`);
