import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AssistantEntry, ProviderDoc } from "@earendil-works/pi-durable";
import { context, openOwner, openStorage, type Owner, transcript } from "../src/owner.ts";
import { RESULTS_DIRECTORY, summarize, writeResult } from "../src/report.ts";

const storageId = `tenant-1#bot-ada#channel-${randomUUID().slice(0, 8)}`;
const log = join(RESULTS_DIRECTORY, "handoff-executions.jsonl");
if (existsSync(log)) rmSync(log);
process.env.PI_SPIKE_EXECUTION_LOG = log;

async function tasks(owner: Owner) {
	const page = await owner.storage.scanTasks({}, 100, undefined, context);
	return page.items.map((task) => ({
		id: task.id,
		kind: task.kind,
		status: task.state.status,
		phase: (task.state.checkpoint as { phase?: string } | undefined)?.phase,
		outcome: task.state.outcome?.status,
	}));
}

const result: Record<string, unknown> = { storageId };

let markParked: () => void = () => {};
const parked = new Promise<void>((resolve) => {
	markParked = resolve;
});
const lambdaOpened = performance.now();
const lambda = await openOwner({
	storageId,
	fence: 1,
	name: "lambda",
	capability: "lambda",
	onParked: () => markParked(),
});
const submission = await lambda.root.submit(
	{
		type: "input",
		content: "Use run_terminal to run `uname -a` on the computer, then tell me the exact output it printed.",
		requestId: "handoff-1",
	},
	context,
);
const raced = await Promise.race([
	parked.then(() => "parked" as const),
	submission.wait(context).then((settled) => `settled:${settled.status}` as const),
]);
result.lambda = {
	outcome: raced,
	millisecondsToPark: Math.round(performance.now() - lambdaOpened),
	tasksWhenParked: await tasks(lambda),
	providerSession: (await lambda.harness.snapshot(ProviderDoc, lambda.root.id, context)) ?? null,
};
const zombie = await openStorage(storageId, 1);
const closing = performance.now();
await lambda.close();
result.lambdaClose = {
	milliseconds: Math.round(performance.now() - closing),
	commits: summarize(lambda.storage.measurements),
	executionsSoFar: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0,
};

const computerOpened = performance.now();
const computer = await openOwner({ storageId, fence: 2, name: "computer", capability: "computer" });
result.computerTasksAtOpen = await tasks(computer);
computer.harness.resume();
const reacquired = await computer.harness.submission(submission.id, context);
const settled = await reacquired!.wait(context);
let answer = "";
if (settled.status === "done" && settled.type === "input") {
	const entry = await computer.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = entry?.model?.[0];
	if (message?.role === "assistant") {
		answer = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}
}
const executions = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
result.computer = {
	status: settled.status,
	millisecondsOpenToDone: Math.round(performance.now() - computerOpened),
	answer,
	executions,
	executionsPerToolTask: executions.filter((each: { phase: string }) => each.phase === "finished").reduce(
		(counts: Record<string, number>, each: { taskId: number }) => ({
			...counts,
			[each.taskId]: (counts[each.taskId] ?? 0) + 1,
		}),
		{},
	),
	tasksAfter: await tasks(computer),
	providerSession: (await computer.harness.snapshot(ProviderDoc, computer.root.id, context)) ?? null,
	commits: summarize(computer.storage.measurements),
};
result.transcript = await transcript(computer);
await computer.close();

try {
	await zombie.commit([], context);
	result.staleLambdaCommitAfterHandoff = "accepted (unexpected)";
} catch (error) {
	result.staleLambdaCommitAfterHandoff = `rejected: ${(error as Error).name}: ${(error as Error).message}`;
}

writeResult("handoff.json", result);
console.log(JSON.stringify(result, null, 2));
