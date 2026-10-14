import { readFileSync } from "node:fs";
import { ownerSessionTags, supervisorSessionTags } from "./session-tags.ts";

/** The roles whose store access the manifest lists: each is one AWS identity the code runs as. */
export const ACCESS_ROLES = ["frontDoor", "ownerTurn", "supervisor"] as const;

/** One of the roles whose store access the manifest lists. */
export type AccessRole = (typeof ACCESS_ROLES)[number];

/** The four stores a role reaches; a row names one of them and a policy names its ARN. */
export const ACCESS_STORES = ["messagingTable", "conversationsTable", "piSessionsBucket", "snapshotBucket"] as const;

/** One of the stores a role reaches. */
export type AccessStore = (typeof ACCESS_STORES)[number];

/**
 * One request shape a role is known to make, and the only way a new request shape becomes allowed to ship. A recorded
 * request must match some row of its role; every row must be allowed by the role's synthesized policy, as the policy
 * evaluator reads it, and by the deployed role as the IAM policy simulator reads it.
 */
export type AccessRow = {
	readonly role: AccessRole;
	readonly action: string;
	readonly store: AccessStore;
	/** A regular expression every partition key, object key or list prefix of a matching request must satisfy. Empty means a request that names no key. */
	readonly keyPattern: string;
	/** A concrete key of this shape, with `{tenantId}`, `{botId}`, `{channelId}`, `{computerId}` and `{turnId}` standing for the example scope. */
	readonly exampleKey: string;
	/** Whether the request goes through an index of the table. */
	readonly index?: boolean;
	/** For an object read: the key always exists when the code reads it, so a 403 for a missing key can never happen. Without it, the policy must let the role list the bucket. */
	readonly keyAlwaysExists?: boolean;
	/** Why the row is the way it is, in a sentence. */
	readonly note?: string;
};

/** The file of the role access manifest; the infra stack tests and the post-deploy simulation read this same file. */
export const ROLE_ACCESS_MANIFEST_FILE = new URL("./role-access-manifest.json", import.meta.url);

/**
 * The rows of the manifest.
 *
 * @param file The manifest file; the deployed one by default.
 * @returns The rows, in file order.
 */
export function loadRoleAccessManifest(file: URL = ROLE_ACCESS_MANIFEST_FILE): AccessRow[] {
	return (JSON.parse(readFileSync(file, "utf8")) as { rows: AccessRow[] }).rows;
}

/** The ids the example keys and the example session tags stand for. */
export const EXAMPLE_SCOPE = { tenantId: "anthus", botId: "bot-1", channelId: "channel-1", computerId: "computer-1", turnId: "turn-1" } as const;

/** The ARN of each store, which the caller takes from the policy or the deployed stack under test. */
export type StoreArns = Readonly<Record<AccessStore, string>>;

/** One request as IAM sees it: the action, the resource it names and the condition keys it carries. */
export type ManifestRequest = {
	readonly action: string;
	readonly resourceArn: string;
	readonly contextKeys: Readonly<Record<string, readonly string[]>>;
};

/** The key of a row with the example scope filled in. */
export const exampleKeyOf = (row: AccessRow): string =>
	row.exampleKey
		.replaceAll("{tenantId}", EXAMPLE_SCOPE.tenantId)
		.replaceAll("{botId}", EXAMPLE_SCOPE.botId)
		.replaceAll("{channelId}", EXAMPLE_SCOPE.channelId)
		.replaceAll("{computerId}", EXAMPLE_SCOPE.computerId)
		.replaceAll("{turnId}", EXAMPLE_SCOPE.turnId);

/** Whether a store is an S3 bucket rather than a DynamoDB table. */
export const isBucketStore = (store: AccessStore): boolean => store === "piSessionsBucket" || store === "snapshotBucket";

/**
 * The request IAM sees for one row: its action, the resource it names and the condition keys it carries, the same way the
 * recording clients shape a recorded request.
 *
 * @param row The row.
 * @param arns The ARNs of the stores of the policy under test.
 * @returns The request.
 */
export function exampleRequestOf(row: AccessRow, arns: StoreArns): ManifestRequest {
	const key = exampleKeyOf(row);
	const storeArn = arns[row.store];
	if (isBucketStore(row.store)) {
		if (row.action === "s3:ListBucket") return { action: row.action, resourceArn: storeArn, contextKeys: { "s3:prefix": [key] } };
		return { action: row.action, resourceArn: `${storeArn}/${key}`, contextKeys: {} };
	}
	return {
		action: row.action,
		resourceArn: row.index === true ? `${storeArn}/index/example` : storeArn,
		contextKeys: key === "" ? {} : { "dynamodb:LeadingKeys": [key] },
	};
}

/** The session tags a role is assumed with in the examples; the Front Door is not assumed and carries none. */
export function exampleTagsOf(role: AccessRole): Record<string, string> {
	if (role === "frontDoor") return {};
	const tags = role === "ownerTurn" ? ownerSessionTags(EXAMPLE_SCOPE) : supervisorSessionTags(EXAMPLE_SCOPE);
	return Object.fromEntries(tags.map((tag) => [tag.Key, tag.Value]));
}

/** A short description of a row for a message: its role, action, store and example key. */
export const describeRow = (row: AccessRow): string => `${row.role} ${row.action} on ${row.store} key ${exampleKeyOf(row) || "(none)"}`;
