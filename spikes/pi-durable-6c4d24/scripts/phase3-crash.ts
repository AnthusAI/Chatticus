import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";
import { context, openOwner, transcript } from "../src/owner.ts";
import { RESULTS_DIRECTORY, summarize, writeResult } from "../src/report.ts";

const child = fileURLToPath(new URL("./crash-child.ts", import.meta.url));

type Scenario = {
	readonly name: string;
	readonly content: string;
	readonly killWhen: "partial" | "tool-started";
	readonly replay?: "safe" | "unsafe";
	readonly toolDelayMs?: number;
};

const scenarios: Scenario[] = [
	{
		name: "kill-mid-model-stream",
		content: "Write about 250 words on why lighthouses were painted in stripes. No tools.",
		killWhen: "partial",
	},
	{
		name: "kill-mid-tool-replay-safe",
		content: "Use run_terminal to run `make test`, then report its output in one line.",
		killWhen: "tool-started",
		replay: "safe",
		toolDelayMs: 8000,
	},
	{
		name: "kill-mid-tool-replay-unsafe",
		content: "Use run_terminal to run `make deploy`, then report its output in one line.",
		killWhen: "tool-started",
		replay: "unsafe",
		toolDelayMs: 8000,
	},
];

const readLog = (path: string) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];

async function runScenario(scenario: Scenario) {
	const storageId = `tenant-1#bot-ada#crash-${scenario.name}-${randomUUID().slice(0, 8)}`;
	const log = join(RESULTS_DIRECTORY, `phase3-${scenario.name}-executions.jsonl`);
	if (existsSync(log)) rmSync(log);
	process.env.PI_SPIKE_EXECUTION_LOG = log;
	const processHandle = spawn(process.execPath, [child], {
		env: {
			...process.env,
			PI_SPIKE_CHILD: JSON.stringify({
				storageId,
				fence: 1,
				name: "owner-1",
				content: scenario.content,
				requestId: `${scenario.name}-1`,
				replay: scenario.replay,
				toolDelayMs: scenario.toolDelayMs,
			}),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	let submissionId: number | undefined;
	let killedAt: string | undefined;
	const started = performance.now();
	const killed = new Promise<void>((resolve) => {
		const kill = (reason: string) => {
			if (killedAt !== undefined) return;
			killedAt = `${reason} after ${Math.round(performance.now() - started)} ms`;
			processHandle.kill("SIGKILL");
			resolve();
		};
		createInterface({ input: processHandle.stdout! }).on("line", (line) => {
			const event = JSON.parse(line) as { event: string; submissionId?: number; textLength?: number };
			if (event.event === "submitted") submissionId = event.submissionId;
			if (scenario.killWhen === "partial" && event.event === "partial" && (event.textLength ?? 0) >= 200) {
				kill(`partial text of ${event.textLength} chars committed`);
			}
		});
		const poll = setInterval(() => {
			if (scenario.killWhen === "tool-started" && readLog(log).some((each) => each.phase === "started")) {
				clearInterval(poll);
				kill("tool execution started");
			}
		}, 50);
		processHandle.on("exit", () => {
			clearInterval(poll);
			resolve();
		});
	});
	await killed;
	await new Promise((resolve) => setTimeout(resolve, 200));

	const resumer = await openOwner({
		storageId,
		fence: 2,
		name: "owner-2",
		capability: "computer",
		replay: scenario.replay,
		toolDelayMs: 200,
	});
	const liveAtReopen = await resumer.harness.snapshot(LiveDoc, resumer.root.id, context);
	const tasksAtReopen = (await resumer.storage.scanTasks({}, 100, undefined, context)).items.map((task) => ({
		id: task.id,
		kind: task.kind,
		status: task.state.status,
		phase: (task.state.checkpoint as { phase?: string } | undefined)?.phase,
	}));
	const resumeStarted = performance.now();
	resumer.harness.resume();
	const submission = submissionId === undefined ? undefined : await resumer.harness.submission(submissionId as never, context);
	const settled = submission === undefined ? undefined : await submission.wait(context);
	const entries = (await resumer.storage.scanEntries({ conversationId: resumer.root.id }, 100, undefined, context)).items;
	const result = {
		scenario: scenario.name,
		storageId,
		killedAt,
		submissionId,
		liveAtReopen: {
			generationPartialTextLength:
				(liveAtReopen?.generation?.message?.content ?? []).reduce(
					(sum: number, part: { type: string; text?: string }) =>
						sum + (part.type === "text" ? (part.text?.length ?? 0) : 0),
					0,
				) || 0,
			tools: liveAtReopen?.tools ?? null,
		},
		tasksAtReopen,
		settled: settled?.status,
		resumeMilliseconds: Math.round(performance.now() - resumeStarted),
		executions: readLog(log),
		entryKinds: [...entries].reverse().map((entry) => ({
			id: entry.id,
			kind: entry.kind,
			stopReason: (entry.model?.[0] as { stopReason?: string } | undefined)?.stopReason,
			isError: (entry.model?.[0] as { isError?: boolean } | undefined)?.isError,
			data: entry.kind === "pi.assistant" ? undefined : entry.data,
		})),
		transcript: await transcript(resumer),
		resumerCommits: summarize(resumer.storage.measurements),
	};
	await resumer.close();
	return result;
}

const results = [];
for (const scenario of scenarios) {
	const result = await runScenario(scenario);
	results.push(result);
	console.log(JSON.stringify(result, null, 2));
}
writeResult("phase3-crash.json", results);
