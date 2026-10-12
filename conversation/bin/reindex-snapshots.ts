import { parseArgs } from "node:util";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { MIGRATION_ENVIRONMENTS } from "../src/migration/cli.ts";
import { reindexSnapshots, type ReindexTarget } from "../src/snapshot/reindex.ts";
import { S3SnapshotStore } from "../src/snapshot/s3.ts";

const MANIFEST_KEY = /^tenants\/([A-Za-z0-9._-]+)\/computers\/([A-Za-z0-9._-]+)\/manifest\.json$/;

async function listTargets(client: S3Client, bucket: string): Promise<ReindexTarget[]> {
	const targets: ReindexTarget[] = [];
	let continuation: string | undefined;
	do {
		const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "tenants/", ContinuationToken: continuation }));
		for (const object of page.Contents ?? []) {
			const match = MANIFEST_KEY.exec(object.Key ?? "");
			if (match !== null) targets.push({ tenantId: match[1]!, computerId: match[2]! });
		}
		continuation = page.NextContinuationToken;
	} while (continuation !== undefined);
	return targets;
}

/**
 * Give every computer's current snapshot a v2 pack and an index. Dry run unless --execute is given; running it twice
 * changes nothing the second time. Run it while the computers are stopped.
 *
 * Usage: reindex-snapshots --environment {development,staging,production} [--tenant T] [--computer C] [--execute].
 * Reads CHATTICUS_SNAPSHOT_BUCKET, the snapshot bucket name (the SnapshotBucketName output of ChatticusSnapshots).
 */
try {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			environment: { type: "string" },
			tenant: { type: "string" },
			computer: { type: "string" },
			execute: { type: "boolean", default: false },
		},
	});
	if (values.environment === undefined || !(MIGRATION_ENVIRONMENTS as readonly string[]).includes(values.environment)) {
		throw new Error(`--environment must be one of ${MIGRATION_ENVIRONMENTS.join(", ")}`);
	}
	const bucket = (process.env.CHATTICUS_SNAPSHOT_BUCKET ?? "").trim();
	if (bucket === "") throw new Error("CHATTICUS_SNAPSHOT_BUCKET is required.");
	const client = new S3Client({});
	const targets = (await listTargets(client, bucket)).filter(
		(target) =>
			(values.tenant === undefined || target.tenantId === values.tenant) &&
			(values.computer === undefined || target.computerId === values.computer),
	);
	const results = await reindexSnapshots(new S3SnapshotStore(bucket, client), targets, { execute: values.execute === true });
	for (const result of results) {
		process.stdout.write(
			`${result.outcome} tenant=${result.tenantId} computer=${result.computerId}` +
				`${result.reason === undefined ? "" : ` reason=${JSON.stringify(result.reason)}`}\n`,
		);
	}
	if (values.execute !== true) process.stdout.write("dry run: nothing was written; pass --execute to re-index\n");
	if (results.some((result) => result.outcome === "failed")) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
