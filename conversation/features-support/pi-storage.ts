import { randomUUID } from "node:crypto";
import { Agent } from "node:http";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";
import type { ChatticusWorld } from "./world.ts";

const creations = new WeakMap<ChatticusWorld, Promise<ScenarioPiStorage>>();

/** The Conversations table and PiSessions bucket one scenario owns, so no two scenarios share a Pi session. */
export type ScenarioPiStorage = {
	readonly tableName: string;
	readonly bucket: string;
	readonly s3: S3Client;
};

/** An S3 client for the scenario's moto. */
export function testS3Client(): S3Client {
	return new S3Client({
		endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
		region: "us-east-1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		forcePathStyle: true,
		maxAttempts: 1,
		requestHandler: { httpAgent: new Agent({ keepAlive: true, maxSockets: 64 }) },
	});
}

/**
 * The scenario's own Pi storage, created on first use. Scenarios name fixed tenants, bots and channels, so a table and
 * bucket shared across scenarios would let one scenario read another's sessions.
 */
export function ensurePiStorage(world: ChatticusWorld): Promise<ScenarioPiStorage> {
	let creating = creations.get(world);
	if (creating === undefined) {
		const suffix = randomUUID();
		const storage: ScenarioPiStorage = { tableName: `Conversations-${suffix}`, bucket: `pisessions-${suffix}`, s3: testS3Client() };
		world.piStorage = storage;
		creating = Promise.all([
			createPiSessionTable(world.messagingTable.client, storage.tableName),
			createPiSessionBucket(storage.s3, storage.bucket),
		]).then(() => storage);
		creations.set(world, creating);
	}
	return creating;
}

/** Remove the scenario's Pi storage, if it created any. */
export async function dropPiStorage(world: ChatticusWorld): Promise<void> {
	const storage = world.piStorage;
	if (storage === null) return;
	await creations.get(world);
	world.piStorage = null;
	creations.delete(world);
	await world.messagingTable.client.send(new DeleteTableCommand({ TableName: storage.tableName }));
	let continuation: string | undefined;
	do {
		const page = await storage.s3.send(new ListObjectsV2Command({ Bucket: storage.bucket, ContinuationToken: continuation }));
		const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
		if (keys.length > 0) await storage.s3.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: keys } }));
		continuation = page.NextContinuationToken;
	} while (continuation !== undefined);
	await storage.s3.send(new DeleteBucketCommand({ Bucket: storage.bucket }));
	storage.s3.destroy();
}
