import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	LOGICAL_SNAPSHOT_BUCKET,
	PACK_FILENAME,
	MANIFEST_FILENAME,
	SnapshotUriError,
	defaultSnapshotBucket,
	snapshotUri,
	snapshotBucketAndPrefix,
	snapshotObjectDir,
} from "../src/snapshot/uri.ts";

describe("snapshot URI", () => {
	const originalEnv = process.env.CHATTICUS_SNAPSHOT_BUCKET;

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.CHATTICUS_SNAPSHOT_BUCKET = originalEnv;
		} else {
			delete process.env.CHATTICUS_SNAPSHOT_BUCKET;
		}
	});

	describe("defaultSnapshotBucket", () => {
		it("returns logical bucket name when env is not set", () => {
			delete process.env.CHATTICUS_SNAPSHOT_BUCKET;
			expect(defaultSnapshotBucket()).toBe(LOGICAL_SNAPSHOT_BUCKET);
		});

		it("returns env value when set", () => {
			process.env.CHATTICUS_SNAPSHOT_BUCKET = "my-bucket";
			expect(defaultSnapshotBucket()).toBe("my-bucket");
		});
	});

	describe("snapshotUri", () => {
		it("creates a valid URI with default bucket", () => {
			delete process.env.CHATTICUS_SNAPSHOT_BUCKET;
			const uri = snapshotUri("tenant-1", "computer-1");
			expect(uri).toBe("s3://chatticus/tenants/tenant-1/computers/computer-1/snapshot");
		});

		it("creates a valid URI with explicit bucket", () => {
			const uri = snapshotUri("tenant-1", "computer-1", { bucket: "my-bucket" });
			expect(uri).toBe("s3://my-bucket/tenants/tenant-1/computers/computer-1/snapshot");
		});

		it("rejects invalid tenant_id", () => {
			expect(() => snapshotUri("tenant/invalid", "computer-1")).toThrow(SnapshotUriError);
		});

		it("rejects invalid computer_id", () => {
			expect(() => snapshotUri("tenant-1", "computer/invalid")).toThrow(SnapshotUriError);
		});

		it("rejects invalid bucket", () => {
			expect(() => snapshotUri("tenant-1", "computer-1", { bucket: "bucket/invalid" })).toThrow(
				SnapshotUriError
			);
		});

		it("allows alphanumeric, dots, underscores, and hyphens in segment", () => {
			const uri = snapshotUri("tenant.test_1-abc", "computer.test_2-xyz");
			expect(uri).toContain("tenant.test_1-abc");
			expect(uri).toContain("computer.test_2-xyz");
		});
	});

	describe("snapshotBucketAndPrefix", () => {
		it("parses a valid snapshot URI", () => {
			const [bucket, prefix] = snapshotBucketAndPrefix(
				"s3://my-bucket/tenants/tenant-1/computers/computer-1/snapshot"
			);
			expect(bucket).toBe("my-bucket");
			expect(prefix).toBe("tenants/tenant-1/computers/computer-1");
		});

		it("rejects non-s3 scheme", () => {
			expect(() => snapshotBucketAndPrefix("http://bucket/tenants/t/computers/c/snapshot")).toThrow(
				SnapshotUriError
			);
		});

		it("rejects invalid path structure", () => {
			expect(() => snapshotBucketAndPrefix("s3://bucket/invalid/path")).toThrow(SnapshotUriError);
		});

		it("rejects malformed URI", () => {
			expect(() => snapshotBucketAndPrefix("not a valid uri")).toThrow(SnapshotUriError);
		});
	});

	describe("snapshotObjectDir", () => {
		it("returns the object directory for a valid URI", () => {
			const dir = snapshotObjectDir(
				"s3://my-bucket/tenants/tenant-1/computers/computer-1/snapshot"
			);
			expect(dir).toBe("tenants/tenant-1/computers/computer-1");
		});
	});

	describe("constants", () => {
		it("defines pack filename", () => {
			expect(PACK_FILENAME).toBe("snapshot.tar.gz");
		});

		it("defines manifest filename", () => {
			expect(MANIFEST_FILENAME).toBe("manifest.json");
		});

		it("defines logical snapshot bucket", () => {
			expect(LOGICAL_SNAPSHOT_BUCKET).toBe("chatticus");
		});
	});
});
