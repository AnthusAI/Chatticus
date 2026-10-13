import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const webDirectory = join(repositoryRoot, "web");
const tsxPath = join(repositoryRoot, "node_modules", ".bin", "tsx");

/**
 * Run one tsx harness from web/test-support, printing JSON on stdout, and
 * return the parsed output. The harness imports production web code.
 */
export async function runWebHarness(
	harnessFileName: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Record<string, any>> {
	const harnessPath = join(webDirectory, "test-support", harnessFileName);
	try {
		const { stdout } = await execFileAsync(tsxPath, [harnessPath, ...args], {
			cwd: webDirectory,
			env: { ...process.env, ...env },
			timeout: 60_000,
		});
		return JSON.parse(stdout) as Record<string, any>;
	} catch (error) {
		const failure = error as { stderr?: string; stdout?: string; message: string };
		throw new Error(`web harness ${harnessFileName} failed: ${failure.stderr || failure.stdout || failure.message}`);
	}
}

const LONG_LIVED_COMMAND_TIMEOUT_MS = 15_000;

/** A tsx harness that stays up for a whole scenario and answers one JSON line per JSON command line. */
export type LongLivedWebHarness = {
	send: <T = unknown>(command: Record<string, unknown>) => Promise<T>;
	close: () => void;
};

/**
 * Start a tsx harness from web/test-support that reads JSON command lines on
 * stdin and writes `{ok, result | error}` lines on stdout. State lives in the
 * process between commands, which one-shot harnesses cannot offer (fake
 * timers, an open panel). The harness imports production web code.
 */
export function startLongLivedWebHarness(harnessFileName: string): LongLivedWebHarness {
	const harnessPath = join(webDirectory, "test-support", harnessFileName);
	const child = spawn(tsxPath, [harnessPath], { cwd: webDirectory, env: process.env });
	const waiting: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	createInterface({ input: child.stdout }).on("line", (line) => {
		const next = waiting.shift();
		if (!next) return;
		const reply = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string };
		if (reply.ok) next.resolve(reply.result);
		else next.reject(new Error(`web harness ${harnessFileName}: ${reply.error}`));
	});
	child.on("exit", () => {
		for (const next of waiting.splice(0)) next.reject(new Error(`web harness ${harnessFileName} exited: ${stderr}`));
	});
	return {
		send: <T>(command: Record<string, unknown>) =>
			new Promise<T>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`web harness ${harnessFileName} timed out on ${JSON.stringify(command)}: ${stderr}`)),
					LONG_LIVED_COMMAND_TIMEOUT_MS,
				);
				waiting.push({
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value as T);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
				child.stdin.write(`${JSON.stringify(command)}\n`);
			}),
		close: () => {
			child.stdin.end();
			child.kill();
		},
	};
}
