import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OVERLAY_INDEX_OBJECT, overlayBlobObject } from "@chatticus/host-protocol/edit-overlay";
import { FilesystemOverlayStore, S3OverlayStore, assertOverlayObjectKey, type OverlayLocation, type OverlayStore } from "../src/snapshot/overlay-store.ts";

const s3Client = new S3Client({
	endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
	region: "us-east-1",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
	forcePathStyle: true,
	maxAttempts: 1,
});

const bucket = `overlay-contract-${randomUUID().slice(0, 12)}`;
const directory = mkdtempSync(join(tmpdir(), "overlay-contract-"));

beforeAll(async () => {
	await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
});

afterAll(async () => {
	rmSync(directory, { recursive: true, force: true });
	const page = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket }));
	const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
	if (keys.length > 0) await s3Client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
	await s3Client.send(new DeleteBucketCommand({ Bucket: bucket }));
	s3Client.destroy();
});

const stores: ReadonlyArray<{ name: string; make: () => OverlayStore }> = [
	{ name: "the S3 store (moto)", make: () => new S3OverlayStore(bucket, s3Client) },
	{ name: "the filesystem store", make: () => new FilesystemOverlayStore(join(directory, randomUUID()), bucket) },
];

const freshLocation = (): OverlayLocation => ({ tenantId: "anthus", computerId: `computer-${randomUUID().slice(0, 8)}` });
const text = (value: string): Buffer => Buffer.from(value, "utf8");
const blobKeyOf = (value: string): string => overlayBlobObject(createHash("sha256").update(value).digest("hex"));

describe.each(stores)("overlay store contract: $name", ({ make }) => {
	it("answers absent for an object that was never written", async () => {
		expect(await make().get(freshLocation(), OVERLAY_INDEX_OBJECT)).toEqual({ kind: "absent" });
	});

	it("creates an object once and refuses a second create", async () => {
		const store = make();
		const location = freshLocation();
		const first = await store.putIfAbsent(location, OVERLAY_INDEX_OBJECT, text("one"));
		expect(first.kind).toBe("written");
		expect(await store.putIfAbsent(location, OVERLAY_INDEX_OBJECT, text("two"))).toEqual({ kind: "precondition_failed" });
		const read = await store.get(location, OVERLAY_INDEX_OBJECT);
		expect(read.kind === "found" && read.object.body.toString()).toBe("one");
	});

	it("replaces an object only with the tag it was read with", async () => {
		const store = make();
		const location = freshLocation();
		const created = await store.putIfAbsent(location, OVERLAY_INDEX_OBJECT, text("v1"));
		if (created.kind !== "written") throw new Error("create failed");
		const replaced = await store.putIfMatch(location, OVERLAY_INDEX_OBJECT, text("v2"), created.etag);
		expect(replaced.kind).toBe("written");
		expect(await store.putIfMatch(location, OVERLAY_INDEX_OBJECT, text("v3"), created.etag)).toEqual({ kind: "precondition_failed" });
		const read = await store.get(location, OVERLAY_INDEX_OBJECT);
		expect(read.kind === "found" && read.object.body.toString()).toBe("v2");
	});

	it("does not match an If-Match write against an absent object", async () => {
		expect(await make().putIfMatch(freshLocation(), OVERLAY_INDEX_OBJECT, text("x"), '"anything"')).toEqual({ kind: "precondition_failed" });
	});

	it("returns the tag a write produced when the object is read back", async () => {
		const store = make();
		const location = freshLocation();
		const created = await store.putIfAbsent(location, OVERLAY_INDEX_OBJECT, text("tagged"));
		if (created.kind !== "written") throw new Error("create failed");
		const read = await store.get(location, OVERLAY_INDEX_OBJECT);
		expect(read.kind === "found" && read.object.etag).toBe(created.etag);
	});

	it("answers not modified when the caller's tag is current, and the body when it is stale", async () => {
		const store = make();
		const location = freshLocation();
		const created = await store.putIfAbsent(location, OVERLAY_INDEX_OBJECT, text("a"));
		if (created.kind !== "written") throw new Error("create failed");
		expect(await store.get(location, OVERLAY_INDEX_OBJECT, created.etag)).toEqual({ kind: "not_modified", etag: created.etag });
		await store.putIfMatch(location, OVERLAY_INDEX_OBJECT, text("b"), created.etag);
		const read = await store.get(location, OVERLAY_INDEX_OBJECT, created.etag);
		expect(read.kind === "found" && read.object.body.toString()).toBe("b");
	});

	it("lets exactly one of two swaps made from the same tag win", async () => {
		const store = make();
		const location = freshLocation();
		const created = await store.putIfAbsent(location, OVERLAY_INDEX_OBJECT, text("start"));
		if (created.kind !== "written") throw new Error("create failed");
		const results = await Promise.all([
			store.putIfMatch(location, OVERLAY_INDEX_OBJECT, text("left"), created.etag),
			store.putIfMatch(location, OVERLAY_INDEX_OBJECT, text("right"), created.etag),
		]);
		expect(results.filter((result) => result.kind === "written")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "precondition_failed")).toHaveLength(1);
	});

	it("deletes a blob and tolerates deleting one that is absent", async () => {
		const store = make();
		const location = freshLocation();
		const key = blobKeyOf("blob body");
		await store.putIfAbsent(location, key, text("blob body"));
		await store.delete(location, key);
		expect(await store.get(location, key)).toEqual({ kind: "absent" });
		await expect(store.delete(location, key)).resolves.toBeUndefined();
	});

	it("keeps the objects of two computers apart", async () => {
		const store = make();
		const first = freshLocation();
		const second = freshLocation();
		await store.putIfAbsent(first, OVERLAY_INDEX_OBJECT, text("first"));
		expect(await store.get(second, OVERLAY_INDEX_OBJECT)).toEqual({ kind: "absent" });
	});

	it("refuses every object name except the index and hash-named blobs", async () => {
		const store = make();
		const location = freshLocation();
		for (const key of ["snapshot.tar.gz", "overlay/../manifest.json", "overlay/blobs/not-a-hash", "overlay/blobs/../../x", "overlay/index.json/extra"]) {
			await expect(store.get(location, key)).rejects.toThrow(/not an overlay object name/);
			await expect(store.putIfAbsent(location, key, text("x"))).rejects.toThrow(/not an overlay object name/);
			await expect(store.delete(location, key)).rejects.toThrow(/not an overlay object name/);
		}
	});

	it("refuses a tenant or computer id that is not a safe path segment", async () => {
		const store = make();
		await expect(store.get({ tenantId: "../other", computerId: "c" }, OVERLAY_INDEX_OBJECT)).rejects.toThrow();
		await expect(store.get({ tenantId: "anthus", computerId: "a/b" }, OVERLAY_INDEX_OBJECT)).rejects.toThrow();
	});
});

describe("overlay object names", () => {
	it("accepts the index and a 64 hex digit blob", () => {
		expect(() => assertOverlayObjectKey(OVERLAY_INDEX_OBJECT)).not.toThrow();
		expect(() => assertOverlayObjectKey(blobKeyOf("x"))).not.toThrow();
	});
});
