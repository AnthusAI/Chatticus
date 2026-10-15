import { URL } from "node:url";
import { basename } from "node:path";

export const LOGICAL_SNAPSHOT_BUCKET = "chatticus";
export const PACK_FILENAME = "snapshot.tar.gz";
export const MANIFEST_FILENAME = "manifest.json";

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The snapshot URI is not a Chatticus computer snapshot location.
 */
export class SnapshotUriError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotUriError";
	}
}

/**
 * Validate that a value matches the allowed segment pattern.
 */
function requireSegment(value: string, name: string): string {
	if (!SEGMENT.test(value)) {
		throw new SnapshotUriError(`Invalid ${name} ${JSON.stringify(value)} in snapshot URI.`);
	}
	return value;
}

/**
 * Return the bucket name from the environment, or the local logical name.
 *
 * Production sets `CHATTICUS_SNAPSHOT_BUCKET` to the CDK
 * `SnapshotBucketName` output. Tests and the filesystem store use the
 * logical name `chatticus`.
 */
export function defaultSnapshotBucket(): string {
	return process.env.CHATTICUS_SNAPSHOT_BUCKET || LOGICAL_SNAPSHOT_BUCKET;
}

/**
 * Return the canonical object-store URI for a computer snapshot.
 */
export function snapshotUri(
	tenantId: string,
	computerId: string,
	{ bucket }: { bucket?: string | null } = {}
): string {
	const resolvedBucket = requireSegment(bucket || defaultSnapshotBucket(), "bucket");
	requireSegment(tenantId, "tenant_id");
	requireSegment(computerId, "computer_id");
	return `s3://${resolvedBucket}/tenants/${tenantId}/computers/${computerId}/snapshot`;
}

/**
 * Return `(bucket, key prefix)` for a snapshot URI.
 *
 * `s3://{bucket}/tenants/{tenant}/computers/{computer}/snapshot` maps to
 * prefix `tenants/{tenant}/computers/{computer}`.
 */
export function snapshotBucketAndPrefix(
	snapshotLocation: string
): [bucket: string, prefix: string] {
	let parsed: URL;
	try {
		parsed = new URL(snapshotLocation);
	} catch {
		throw new SnapshotUriError(`Invalid snapshot URI ${JSON.stringify(snapshotLocation)}.`);
	}

	if (parsed.protocol !== "s3:") {
		throw new SnapshotUriError(
			`Snapshot URI must use the s3 scheme, not ${JSON.stringify(parsed.protocol.slice(0, -1))}.`
		);
	}

	const bucket = requireSegment(parsed.hostname || "", "bucket");
	const parts = parsed.pathname
		.split("/")
		.filter((p) => p.length > 0);

	if (
		parts.length !== 5 ||
		parts[0] !== "tenants" ||
		parts[2] !== "computers" ||
		parts[4] !== "snapshot"
	) {
		throw new SnapshotUriError(
			`Snapshot URI path is not a computer snapshot: ${JSON.stringify(snapshotLocation)}.`
		);
	}

	const tenantId = requireSegment(parts[1], "tenant_id");
	const computerId = requireSegment(parts[3], "computer_id");
	const prefix = `tenants/${tenantId}/computers/${computerId}`;
	return [bucket, prefix];
}

/**
 * Return the relative store directory for a snapshot URI.
 */
export function snapshotObjectDir(snapshotLocation: string): string {
	const [, prefix] = snapshotBucketAndPrefix(snapshotLocation);
	return prefix;
}
