/**
 * Writes generated/executor-seamed.ts: the production turn executor with ONE changed line, so the spike can swap the
 * computer tool set without editing conversation/src. Prints the diff against the production file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "conversation", "src", "turn", "executor.ts");
const target = join(here, "..", "generated", "executor-seamed.ts");
const original = readFileSync(source, "utf8");

const seamLine = "\t\t\t\tcomputerToolsExtension(this.computerHandoff()),";
const replacement =
	"\t\t\t\t...((this.deps as unknown as { computerToolsOverride?: (handoff: ComputerToolHandoff) => Extension[] }).computerToolsOverride?.(this.computerHandoff()) ?? [computerToolsExtension(this.computerHandoff())]),";
if (!original.includes(seamLine)) throw new Error("The seam line was not found in executor.ts; the executor changed.");

let rewritten = original
	.replaceAll(/from "\.\.\//g, 'from "../../../conversation/src/')
	.replaceAll(/from "\.\//g, 'from "../../../conversation/src/turn/')
	.replace(seamLine, replacement)
	.replace('import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";', 'import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";\nimport type { Extension } from "@earendil-works/pi-durable";');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, rewritten);

const normalized = join(here, "..", "generated", "executor-normalized.ts");
writeFileSync(
	normalized,
	original.replaceAll(/from "\.\.\//g, 'from "../../../conversation/src/').replaceAll(/from "\.\//g, 'from "../../../conversation/src/turn/'),
);
const diff = spawnSync("diff", ["-u", normalized, target], { encoding: "utf8" });
console.log(diff.stdout.replace(/^--- .*$/m, "--- conversation/src/turn/executor.ts (imports rebased)").replace(/^\+\+\+ .*$/m, "+++ generated/executor-seamed.ts"));
