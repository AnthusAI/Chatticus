import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { type SweepResult, sweepAllStorages, sweepOrphans, type SweeperDependencies } from "../pi/sweeper.ts";

/** The part of a scheduled or manual invocation this handler reads: an optional list of storages to sweep. */
export type OrphanSweeperEvent = { readonly storageIds?: readonly string[] };

/** What the handler reports for one invocation. */
export type OrphanSweeperReport = SweepResult & { readonly storages: number };

const DEFAULT_GRACE_SECONDS = 3600;

const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
};

const graceMilliseconds = (): number => {
	const configured = process.env.CHATTICUS_ORPHAN_GRACE_SECONDS;
	if (configured === undefined || configured === "") return DEFAULT_GRACE_SECONDS * 1000;
	const seconds = Number(configured);
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new Error(`CHATTICUS_ORPHAN_GRACE_SECONDS must be a non-negative number, got ${configured}.`);
	}
	return seconds * 1000;
};

let cachedDependencies: SweeperDependencies | null = null;

function sweeperDependencies(): SweeperDependencies {
	if (cachedDependencies !== null) return cachedDependencies;
	cachedDependencies = {
		client: new DynamoDBClient({}),
		s3: new S3Client({}),
		tableName: requiredEnvironment("CHATTICUS_CONVERSATIONS_TABLE"),
		bucket: requiredEnvironment("CHATTICUS_PI_SESSIONS_BUCKET"),
		clock: { now: () => new Date() },
		graceMilliseconds: graceMilliseconds(),
	};
	return cachedDependencies;
}

/**
 * Entry point of the scheduled orphan sweeper. With no `storageIds` it sweeps every storage found in the bucket.
 *
 * @param event Optional storages to sweep instead of all of them.
 * @returns Totals deleted and the number of storages swept.
 */
export async function handler(event: OrphanSweeperEvent = {}): Promise<OrphanSweeperReport> {
	const dependencies = sweeperDependencies();
	if (event.storageIds === undefined) return sweepAllStorages(dependencies);
	let deleted = 0;
	let deletedSnapshots = 0;
	for (const storageId of event.storageIds) {
		const result = await sweepOrphans(dependencies, storageId);
		deleted += result.deleted;
		deletedSnapshots += result.deletedSnapshots;
	}
	return { deleted, deletedSnapshots, storages: event.storageIds.length };
}
