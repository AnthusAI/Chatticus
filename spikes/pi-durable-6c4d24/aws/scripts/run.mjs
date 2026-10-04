import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FN = JSON.parse(readFileSync("build/outputs.json", "utf8")).ChatticusPiDurableSpike.FunctionName;
const AWS = ["--profile", "chatticus-development", "--region", "us-east-1"];
const aws = (...args) => execFileSync("aws", [...args, ...AWS], { encoding: "utf8", maxBuffer: 64 << 20 });
mkdirSync("build/invokes", { recursive: true });

function recycle(nonce) {
  aws("lambda", "update-function-configuration", "--function-name", FN, "--environment",
    JSON.stringify({ Variables: { ...JSON.parse(aws("lambda", "get-function-configuration", "--function-name", FN, "--query", "Environment.Variables")), NONCE: String(nonce) } }),
    "--query", "LastUpdateStatus", "--output", "text");
  aws("lambda", "wait", "function-updated-v2", "--function-name", FN);
}

function invoke(label, payload) {
  const out = `build/invokes/${label}.json`;
  writeFileSync(`build/invokes/${label}.in.json`, JSON.stringify(payload));
  const started = performance.now();
  const meta = JSON.parse(aws("lambda", "invoke", "--function-name", FN, "--cli-binary-format", "raw-in-base64-out",
    "--payload", `file://build/invokes/${label}.in.json`, "--log-type", "Tail", "--cli-read-timeout", "200", out));
  const wallMs = performance.now() - started;
  const log = Buffer.from(meta.LogResult ?? "", "base64").toString();
  const report = log.split("\n").find((line) => line.startsWith("REPORT")) ?? "";
  const grab = (name) => Number((report.match(new RegExp(`${name}: ([0-9.]+)`)) ?? [])[1] ?? NaN);
  const body = JSON.parse(readFileSync(out, "utf8"));
  const record = {
    label, payload, functionError: meta.FunctionError, wallMs: Math.round(wallMs),
    durationMs: grab("Duration"), billedMs: grab("Billed Duration"), initMs: grab("Init Duration"), maxMemoryMB: grab("Max Memory Used"),
    body,
  };
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(label, record.functionError ?? "ok", "dur", record.durationMs, "init", record.initMs, "status", body?.result?.status ?? body?.errorMessage ?? "");
  return record;
}

const only = process.argv[2];
if (only === "smoke") { recycle(Date.now()); invoke("smoke", { action: "turn", kind: "plain" }); process.exit(0); }
if (only === "latency") {
  recycle(Date.now()); invoke("cold1-plain", { action: "turn", kind: "plain" });
  for (let i = 1; i <= 10; i++) invoke(`warm-plain-${i}`, { action: "turn", kind: "plain" });
  for (let i = 1; i <= 3; i++) invoke(`warm-tool-${i}`, { action: "turn", kind: "tool" });
  recycle(Date.now() + 1); invoke("cold2-plain", { action: "turn", kind: "plain" });
  recycle(Date.now() + 2); invoke("cold3-tool", { action: "turn", kind: "tool" });
}
if (only === "faults") {
  invoke("lost-retryable", { action: "lost-response", errorName: "TimeoutError", skip: 2 });
  invoke("lost-nonretryable", { action: "lost-response", errorName: "SimulatedLostResponse", skip: 2 });
  invoke("conflict", { action: "conflict", trials: 20 });
}
