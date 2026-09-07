#!/usr/bin/env node
/**
 * Synth CustomerComputersStack and fail when the committed Python artifact drifts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const infraDir = join(scriptDir, "..");
const repoRoot = join(infraDir, "..");
const artifactPath = join(
  repoRoot,
  "python/src/chatticus/assets/customer-computers.template.json",
);

execFileSync(
  "npx",
  ["cdk", "--app", "npx ts-node bin/customer-computers.ts", "synth", "ChatticusComputers", "-q"],
  { cwd: infraDir, stdio: "inherit" },
);

const synthesized = readFileSync(
  join(infraDir, "cdk.out/ChatticusComputers.template.json"),
  "utf8",
);
const committed = readFileSync(artifactPath, "utf8");

const normalize = (text) => JSON.stringify(JSON.parse(text));
if (normalize(synthesized) !== normalize(committed)) {
  writeFileSync(artifactPath, `${JSON.stringify(JSON.parse(synthesized), null, 2)}\n`);
  console.error(
    "customer-computers.template.json drifted from CDK synth; file updated for review.",
  );
  process.exit(1);
}

const byteLength = Buffer.byteLength(synthesized, "utf8");
console.log(`CustomerComputers template: ${byteLength} bytes (limit 51200 for TemplateBody).`);
if (byteLength > 51_200) {
  console.error("Template exceeds TemplateBody limit; configure TemplateURL delivery.");
  process.exit(1);
}
