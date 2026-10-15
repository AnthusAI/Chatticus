import { randomUUID } from "node:crypto";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { claimFence, context, openOwner, openStorage, transcript } from "../src/owner.ts";
import { summarize, writeResult } from "../src/report.ts";

const storageId = `tenant-1#bot-ada#channel-${randomUUID().slice(0, 8)}`;

async function answerText(owner: Awaited<ReturnType<typeof openOwner>>, answer: number): Promise<string> {
	const entry = await owner.root.commit((tx) => tx.entry(AssistantEntry, answer as never), context);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const result: Record<string, unknown> = { storageId };

const first = await openOwner({ storageId, fence: 1, name: "owner-1", capability: "computer" });
let started = performance.now();
const submission = await first.root.submit(
	{ type: "input", content: "My favourite colour is teal. Reply with one short sentence.", requestId: "msg-1" },
	context,
);
const settled = await submission.wait(context);
result.turn1 = {
	submissionId: submission.id,
	status: settled.status,
	milliseconds: Math.round(performance.now() - started),
	answer: settled.status === "done" && settled.type === "input" ? await answerText(first, settled.answer) : settled,
	commits: summarize(first.storage.measurements),
};
await first.close();

const reopenStarted = performance.now();
const second = await openOwner({ storageId, fence: 2, name: "owner-2", capability: "computer" });
result.reopen = {
	milliseconds: Math.round(performance.now() - reopenStarted),
	readRoundTrips: second.storage.reads,
	commits: second.storage.measurements.length,
};
const again = await second.root.submit(
	{ type: "input", content: "My favourite colour is teal. Reply with one short sentence.", requestId: "msg-1" },
	context,
);
const againRecord = await again.status(context);
result.duplicateRequestId = {
	sameSubmission: again.id === submission.id,
	originalId: submission.id,
	returnedId: again.id,
	status: againRecord.status,
	commitsCausedByDuplicate: second.storage.measurements.length,
};
started = performance.now();
const followUp = await second.root.submit(
	{ type: "input", content: "What is my favourite colour? One word.", requestId: "msg-2" },
	context,
);
const followUpSettled = await followUp.wait(context);
result.turn2 = {
	status: followUpSettled.status,
	milliseconds: Math.round(performance.now() - started),
	answer:
		followUpSettled.status === "done" && followUpSettled.type === "input"
			? await answerText(second, followUpSettled.answer)
			: followUpSettled,
	commits: summarize(second.storage.measurements),
};
result.transcript = await transcript(second);
await second.close();

const stale = await openStorage(storageId, 1);
try {
	await stale.commit([], context);
	result.staleOwnerCommit = "accepted (unexpected)";
} catch (error) {
	result.staleOwnerCommit = `rejected: ${(error as Error).name}: ${(error as Error).message}`;
}
try {
	await claimFence(storageId, 1);
	result.staleFenceClaim = "accepted (unexpected)";
} catch (error) {
	result.staleFenceClaim = `rejected: ${(error as Error).name}`;
}

writeResult("phase2-turns.json", result);
console.log(JSON.stringify(result, null, 2));
