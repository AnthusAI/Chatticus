import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { ComputerHostDisk } from "../src/snapshot/host.ts";
import { S3SnapshotStore } from "../src/snapshot/s3.ts";
import type { SnapshotManifest, SnapshotReadStore } from "../src/snapshot/store.ts";
import { recordingS3Client, type RecordedAwsRequest } from "./aws-request-recorder.ts";
import { testS3Client } from "./pi-storage.ts";
import type { ChatticusWorld } from "./world.ts";

/** One response of a file route, read once. */
export type FileRouteResponse = { status: number; text: string; json: any; headers: Headers };

/** What a scenario about the computer file routes remembers between its steps. */
export type FileRoutesScenario = {
	bucket: string | null;
	/** Every S3 request the publishing host sent, in order. */
	publisherRequests: RecordedAwsRequest[];
	/** Every S3 request the Front Door's file routes sent, in order. */
	readerRequests: RecordedAwsRequest[];
	publisherStore: S3SnapshotStore | null;
	readerStore: S3SnapshotStore | null;
	disk: ComputerHostDisk | null;
	response: FileRouteResponse | null;
	computerRecordAfterPublish: string | null;
	/** A directory a restore of the published pack was unpacked into. */
	restoredRoot: string | null;
	/** The manifest of the last publish. */
	manifest: SnapshotManifest | null;
};

const scenarios = new WeakMap<ChatticusWorld, FileRoutesScenario>();

/** The scenario's file route state, created on first use. */
export function fileRoutesOf(world: ChatticusWorld): FileRoutesScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			bucket: null,
			publisherRequests: [],
			readerRequests: [],
			publisherStore: null,
			readerStore: null,
			disk: null,
			response: null,
			computerRecordAfterPublish: null,
			restoredRoot: null,
			manifest: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

/**
 * The store the Front Door's file routes read through, resolved lazily so a front door wired before the scenario made its
 * bucket reads the bucket when a request arrives. Every request it sends is noted in the scenario.
 */
export function snapshotReadStoreOf(world: ChatticusWorld): SnapshotReadStore {
	const reader = (): S3SnapshotStore => {
		const scenario = fileRoutesOf(world);
		assert.ok(scenario.bucket, "The scenario has no snapshot bucket for the file routes.");
		scenario.readerStore ??= new S3SnapshotStore(scenario.bucket, recordingS3Client(testS3Client(), scenario.readerRequests));
		return scenario.readerStore;
	};
	return {
		get bucket() {
			return fileRoutesOf(world).bucket ?? "chatticus";
		},
		getManifest: (uri) => reader().getManifest(uri),
		getIndexBytes: (uri, checksum) => reader().getIndexBytes(uri, checksum),
		getPackRange: (uri, offset, length) => reader().getPackRange(uri, offset, length),
	};
}

/** Make the scenario's bucket and the stores that publish to it. */
export async function createFileRoutesBucket(world: ChatticusWorld): Promise<void> {
	const scenario = fileRoutesOf(world);
	const bucket = `snapfiles-${randomUUID().slice(0, 12)}`;
	const client = testS3Client();
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} finally {
		client.destroy();
	}
	scenario.bucket = bucket;
	scenario.publisherStore = new S3SnapshotStore(bucket, recordingS3Client(testS3Client(), scenario.publisherRequests));
}

/** The live disk the scenario's computer publishes from, created on first use. */
export function computerDiskOf(world: ChatticusWorld): ComputerHostDisk {
	const scenario = fileRoutesOf(world);
	assert.ok(scenario.publisherStore, "The scenario has no snapshot bucket for the file routes.");
	assert.ok(world.snapshotTmpdir, "The scenario has no snapshot directory.");
	scenario.disk ??= new ComputerHostDisk(join(world.snapshotTmpdir, "hosts", "file-routes-computer"), scenario.publisherStore);
	return scenario.disk;
}

/** Delete what the scenario left in its bucket and the bucket, and the directory a restore was unpacked into. */
export async function cleanUpFileRoutesScenario(world: ChatticusWorld): Promise<void> {
	const scenario = scenarios.get(world);
	scenarios.delete(world);
	if (scenario?.restoredRoot) rmSync(scenario.restoredRoot, { recursive: true, force: true });
	if (scenario?.bucket === null || scenario === undefined) return;
	const client = testS3Client();
	try {
		let continuation: string | undefined;
		do {
			const page = await client.send(new ListObjectsV2Command({ Bucket: scenario.bucket, ContinuationToken: continuation }));
			const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
			if (keys.length > 0) await client.send(new DeleteObjectsCommand({ Bucket: scenario.bucket, Delete: { Objects: keys } }));
			continuation = page.NextContinuationToken;
		} while (continuation !== undefined);
		await client.send(new DeleteBucketCommand({ Bucket: scenario.bucket }));
	} finally {
		client.destroy();
	}
}
