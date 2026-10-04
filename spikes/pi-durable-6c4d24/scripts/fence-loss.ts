import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DynamoDbStorage } from "../src/dynamodb-storage.ts";
import { context, openOwner, TABLE_NAME, transcript } from "../src/owner.ts";
import { RESULTS_DIRECTORY, writeResult } from "../src/report.ts";
import { createLocalClient } from "../src/table.ts";

const storageId = `tenant-1#bot-ada#fence-loss-${randomUUID().slice(0, 8)}`;
const log = join(RESULTS_DIRECTORY, "fence-loss-executions.jsonl");
if (existsSync(log)) rmSync(log);
process.env.PI_SPIKE_EXECUTION_LOG = log;
const readLog = () =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { phase: string; owner: string; taskId: number })
		: [];

const result: Record<string, unknown> = { storageId };
const stale = await openOwner({ storageId, fence: 1, name: "stale", capability: "computer", toolDelayMs: 4000 });
const submission = await stale.root.submit(
	{
		type: "input",
		content: "Use run_terminal to run `make test`, then run `make lint` with run_terminal too, then report both outputs.",
		requestId: "fence-loss-1",
	},
	context,
);
const waited = submission.wait(context).then(
	(settled) => `settled: ${settled.status}`,
	(error: Error) => `rejected: ${error.name}: ${error.message}`,
);
while (!readLog().some((event) => event.phase === "started")) await new Promise((resolve) => setTimeout(resolve, 50));
await DynamoDbStorage.claimOwnership({ client: createLocalClient(), tableName: TABLE_NAME, storageId, fence: 2 });
const fencedAt = Date.now();
const staleOutcome = await Promise.race([
	waited,
	new Promise<string>((resolve) => setTimeout(() => resolve("still waiting after 15 s"), 15000)),
]);
await new Promise((resolve) => setTimeout(resolve, 3000));
result.stale = {
	submissionOutcome: staleOutcome,
	rejectedCommits: stale.storage.measurements.filter((each) => each.rejected !== undefined).map((each) => each.rejected),
	successfulCommits: stale.storage.measurements.filter((each) => each.rejected === undefined).length,
	toolStartsAfterFence: readLog().filter((event) => event.owner === "stale" && event.phase === "started").length - 1,
	executionsByStale: readLog().filter((event) => event.owner === "stale"),
	millisecondsObservedAfterFence: Date.now() - fencedAt,
};
const closeOutcome = await stale.close().then(
	() => "closed",
	(error: Error) => `close rejected: ${error.name}: ${error.message}`,
);
result.staleClose = closeOutcome;

const next = await openOwner({ storageId, fence: 3, name: "next", capability: "computer", toolDelayMs: 200 });
next.harness.resume();
const settled = await (await next.harness.submission(submission.id, context))!.wait(context);
result.next = {
	status: settled.status,
	executions: readLog().filter((event) => event.owner === "next"),
	transcript: await transcript(next),
};
await next.close();

writeResult("fence-loss.json", result);
console.log(JSON.stringify(result, null, 2));
