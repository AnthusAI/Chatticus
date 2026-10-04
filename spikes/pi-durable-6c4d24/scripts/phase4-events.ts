import { randomUUID } from "node:crypto";
import { DeleteItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { type AgentEvent, AssistantEntry, watchEvents } from "@earendil-works/pi-durable";
import { DynamoDbStorage } from "../src/dynamodb-storage.ts";
import { context, openOwner, type Owner, TABLE_NAME, transcript } from "../src/owner.ts";
import { summarize, writeResult } from "../src/report.ts";
import { createLocalClient } from "../src/table.ts";

const storageId = `tenant-1#bot-ada#channel-${randomUUID().slice(0, 8)}`;
const mailboxKey = `MB#${storageId}`;
const client = createLocalClient();

async function answerText(owner: Owner, answer: number): Promise<string> {
	const entry = await owner.root.commit((tx) => tx.entry(AssistantEntry, answer as never), context);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

type Batch = { readonly kinds: string[]; readonly bytes: number };

async function observedTurn(owner: Owner, content: string, requestId: string, during?: () => Promise<void>) {
	const stream = await watchEvents(owner.harness, owner.root.id, context);
	const snapshotBytes = Buffer.byteLength(JSON.stringify(stream.snapshot));
	const batches: Batch[] = [];
	stream.start(async (events: readonly AgentEvent[]) => {
		batches.push({ kinds: events.map((event) => event.type), bytes: Buffer.byteLength(JSON.stringify(events)) });
	});
	const commitsBefore = owner.storage.measurements.length;
	const submission = await owner.root.submit({ type: "input", content, requestId }, context);
	const duringWork = during?.();
	const settled = await submission.wait(context);
	await duringWork;
	await new Promise((resolve) => setTimeout(resolve, 300));
	await stream.stop();
	const kindCounts: Record<string, number> = {};
	for (const batch of batches) for (const kind of batch.kinds) kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
	const sizes = batches.map((batch) => batch.bytes).sort((a, b) => a - b);
	return {
		status: settled.status,
		answer: settled.status === "done" && settled.type === "input" ? await answerText(owner, settled.answer) : settled,
		stream: {
			snapshotBytes,
			batches: batches.length,
			eventKinds: kindCounts,
			totalBytes: sizes.reduce((sum, size) => sum + size, 0),
			batchBytesP50: sizes[Math.floor(sizes.length / 2)] ?? 0,
			batchBytesMax: sizes.at(-1) ?? 0,
			firstBatches: batches.slice(0, 12).map((batch) => batch.kinds.join(",")),
		},
		commits: summarize(owner.storage.measurements.slice(commitsBefore)),
	};
}

async function postToMailbox(author: string, text: string): Promise<string> {
	const messageId = `msg-${randomUUID().slice(0, 8)}`;
	await client.send(
		new PutItemCommand({
			TableName: TABLE_NAME,
			Item: {
				pk: { S: mailboxKey },
				sk: { S: messageId },
				author: { S: author },
				text: { S: text },
			},
		}),
	);
	return messageId;
}

async function drainMailbox(owner: Owner): Promise<string[]> {
	const response = await client.send(
		new QueryCommand({
			TableName: TABLE_NAME,
			KeyConditionExpression: "pk = :pk",
			ExpressionAttributeValues: { ":pk": { S: mailboxKey } },
			ConsistentRead: true,
		}),
	);
	const admitted: string[] = [];
	for (const item of response.Items ?? []) {
		const messageId = item.sk!.S!;
		await owner.root.submit(
			{
				type: "input",
				content: `[from ${item.author!.S}] ${item.text!.S}`,
				whenBusy: "steer",
				requestId: messageId,
			},
			context,
		);
		await client.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { pk: item.pk!, sk: item.sk! } }));
		admitted.push(messageId);
	}
	return admitted;
}

const result: Record<string, unknown> = { storageId };
const owner = await openOwner({
	storageId,
	fence: 1,
	name: "owner-1",
	capability: "computer",
	toolDelayMs: 3000,
	blockedCommands: ["rm -rf /srv/build"],
});

const write = await owner.root.submit(
	{
		type: "write",
		requestId: "bea-1",
		entry: {
			kind: "chatticus.message",
			data: { author: "bea", text: "The deploy window moved to Friday 3pm." },
			model: [{ role: "user", content: "[from Bea] The deploy window moved to Friday 3pm.", timestamp: Date.now() }],
		},
	},
	context,
);
result.attributedWrite = { submissionId: write.id, status: (await write.wait(context)).status };
result.attributionTurn = await observedTurn(
	owner,
	"When is the deploy window now, and which teammate told us? One sentence.",
	"ryan-1",
);

result.toolTurn = await observedTurn(owner, "Use run_terminal to run `ls /srv`, then report the output.", "ryan-2");

result.gatedTurn = await observedTurn(
	owner,
	"Use run_terminal to run exactly `rm -rf /srv/build`. Report what happened.",
	"ryan-3",
);

const intruder = await DynamoDbStorage.open({ client, tableName: TABLE_NAME, storageId });
const mailboxTurn = await observedTurn(
	owner,
	"Use run_terminal to run `make build`, then summarize for the channel in two sentences.",
	"ryan-4",
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		let directCommit: string;
		try {
			await intruder.commit([], context);
			directCommit = "accepted";
		} catch (error) {
			directCommit = `rejected: ${(error as Error).message}`;
		}
		const posted = await postToMailbox("Bea", "Also mention that the build server is in eu-west-1.");
		const admitted: string[] = [];
		for (let attempt = 0; attempt < 40 && admitted.length === 0; attempt++) {
			admitted.push(...(await drainMailbox(owner)));
			if (admitted.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		result.nonOwnerMutation = { directCommitWhileOwned: directCommit, posted, admittedAsSteer: admitted };
	},
);
result.mailboxTurn = mailboxTurn;
result.transcript = await transcript(owner);
await owner.close();

writeResult("phase4-events.json", result);
console.log(JSON.stringify(result, null, 2));
