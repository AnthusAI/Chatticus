import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { beforeAll, describe, expect, it } from "vitest";
import { CommitOutcomeUnknown, isFatalCommitUncertain, OwnershipLost } from "../src/pi/errors.ts";
import { chatticusExtensions } from "../src/pi/extension.ts";
import { openOwnerSession, openOwnerStorage } from "../src/pi/session.ts";
import { IndexedStorage } from "../src/storage/indexed-storage.ts";
import { storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const tableName = "pi-session-factory";
const bucket = "pi-session-factory";
const dependencies = { client, s3, tableName, bucket };

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

const freshStorageId = (): string => storageIdFor("tenant", "bot", randomUUID());

describe("allocateFence", () => {
	it("starts at 1 and rises by one per allocation", async () => {
		const storageId = freshStorageId();
		expect(await IndexedStorage.allocateFence(client, tableName, storageId)).toBe(1);
		expect(await IndexedStorage.allocateFence(client, tableName, storageId)).toBe(2);
		expect(await IndexedStorage.allocateFence(client, tableName, storageId)).toBe(3);
	});

	it("keeps partitions independent", async () => {
		const first = freshStorageId();
		await IndexedStorage.allocateFence(client, tableName, first);
		expect(await IndexedStorage.allocateFence(client, tableName, freshStorageId())).toBe(1);
	});

	it("allocates concurrently without duplicates", async () => {
		const storageId = freshStorageId();
		const fences = await Promise.all(Array.from({ length: 6 }, () => IndexedStorage.allocateFence(client, tableName, storageId)));
		expect([...fences].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("continues above a fence set by claimOwnership", async () => {
		const storageId = freshStorageId();
		await IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 1001 });
		expect(await IndexedStorage.allocateFence(client, tableName, storageId)).toBe(1002);
	});
});

describe("openOwnerStorage", () => {
	it("returns storage fenced with the allocated number", async () => {
		const storageId = freshStorageId();
		const first = await openOwnerStorage(storageId, dependencies);
		const second = await openOwnerStorage(storageId, dependencies);
		expect([first.fence, second.fence]).toEqual([1, 2]);
	});
});

describe("errors", () => {
	it("treats only an unknown commit outcome as fatal uncertainty", () => {
		expect(isFatalCommitUncertain(new CommitOutcomeUnknown("x"))).toBe(true);
		expect(isFatalCommitUncertain(new OwnershipLost("x"))).toBe(false);
		expect(isFatalCommitUncertain(new Error("x"))).toBe(false);
	});
});

describe("openOwnerSession", () => {
	it("renders the section into the model request and runs the registered tool", async () => {
		const faux = fauxProvider({ models: [{ id: "faux-model" }] });
		const requests: string[] = [];
		const notes: string[] = [];
		faux.setResponses([
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage([fauxToolCall("note_to_channel", { note: "remember" })], { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("done");
			},
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const owner = await openOwnerSession(freshStorageId(), {
			...dependencies,
			models,
			extensions: chatticusExtensions({ systemPrompt: () => "You are Ada the tester.", onChannelNote: (note) => notes.push(note) }),
			context: BACKGROUND_CONTEXT,
		});
		const agent = { model: { provider: faux.provider.id, modelId: "faux-model" }, thinkingLevel: "off" as const };
		const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
		await root.configure(agent, BACKGROUND_CONTEXT);
		const submission = await root.submit({ type: "input", content: "hi", requestId: "r1" }, BACKGROUND_CONTEXT);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		await owner.close();
		expect(settled.type === "input" && settled.status).toBe("done");
		expect(notes).toEqual(["remember"]);
		expect(requests[0]).toContain("You are Ada the tester.");
		expect(requests[0]).toContain("note_to_channel");
		expect(owner.fence).toBe(1);
	});
});
