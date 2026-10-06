import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { beforeAll, describe, expect, it } from "vitest";
import type { Turn } from "../src/domain/turns.ts";
import { readEntryBody } from "../src/pi/channel-log.ts";
import { chatticusExtensions } from "../src/pi/extension.ts";
import { openOwnerSession } from "../src/pi/session.ts";
import { PiSubmissionInspector, readTurnSubmission, turnRequestId } from "../src/pi/submission-inspector.ts";
import { IndexedStorage } from "../src/storage/indexed-storage.ts";
import { storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const tableName = "submission-inspector";
const bucket = "submission-inspector";
const dependencies = { client, s3, tableName, bucket };

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

async function answerAndAbandon(storageId: string, turnId: string, answer: string): Promise<void> {
	const faux = fauxProvider({ models: [{ id: "faux-model" }] });
	faux.setResponses([() => fauxAssistantMessage(answer)]);
	const models = createModels();
	models.setProvider(faux.provider);
	const owner = await openOwnerSession(storageId, {
		...dependencies,
		models,
		extensions: chatticusExtensions({ systemPrompt: () => "You are Ada the tester." }),
		context: BACKGROUND_CONTEXT,
	});
	const agent = { model: { provider: faux.provider.id, modelId: "faux-model" }, thinkingLevel: "off" as const };
	const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
	await root.configure(agent, BACKGROUND_CONTEXT);
	const submission = await root.submit({ type: "input", content: "hi", requestId: turnRequestId(turnId) }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT);
}

describe("readTurnSubmission", () => {
	it("finds a done submission and its answer in a session whose owner was abandoned without close", async () => {
		const turnId = randomUUID();
		const storageId = storageIdFor("tenant", "bot", randomUUID());
		await answerAndAbandon(storageId, turnId, "The answer the dead owner produced.");
		const reader = await IndexedStorage.open({ ...dependencies, storageId });
		const record = await readTurnSubmission(reader, turnId);
		expect(record?.type).toBe("input");
		expect(record?.status).toBe("done");
		const answer = record?.type === "input" && record.status === "done" ? record.answer : undefined;
		expect(answer).toBeDefined();
		expect(await readEntryBody(reader, answer as number)).toBe("The answer the dead owner produced.");
	});

	it("finds nothing for a turn the session never saw", async () => {
		const storageId = storageIdFor("tenant", "bot", randomUUID());
		await answerAndAbandon(storageId, randomUUID(), "Another turn.");
		const reader = await IndexedStorage.open({ ...dependencies, storageId });
		expect(await readTurnSubmission(reader, randomUUID())).toBeUndefined();
	});
});

describe("PiSubmissionInspector", () => {
	const turnFor = (turnId: string, channelId: string): Turn =>
		({ turnId, tenantId: "tenant", botId: "bot", channelId }) as Turn;

	it("reports an answered turn and an unanswered one", async () => {
		const channelId = randomUUID();
		const answered = randomUUID();
		await answerAndAbandon(storageIdFor("tenant", "bot", channelId), answered, "Answered.");
		const inspector = new PiSubmissionInspector(dependencies);
		expect(await inspector.turnAnswered(turnFor(answered, channelId))).toBe(true);
		expect(await inspector.turnAnswered(turnFor(randomUUID(), channelId))).toBe(false);
	});
});
