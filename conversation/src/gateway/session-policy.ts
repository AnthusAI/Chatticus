import { commitPrefix, storageIdFor } from "../storage/storage-support.ts";

/** One statement of an IAM policy document. */
export type PolicyStatement = {
	readonly Sid: string;
	readonly Effect: "Allow";
	readonly Action: readonly string[];
	readonly Resource: readonly string[];
	readonly Condition?: Record<string, Record<string, readonly string[]>>;
};

/** An IAM session policy as data, ready to pass as the `Policy` of an STS call. */
export type SessionPolicyDocument = {
	readonly Version: "2012-10-17";
	readonly Statement: readonly PolicyStatement[];
};

/** The one conversation session a container may read and write, and where its stores live. */
export type SessionScope = {
	readonly tenantId: string;
	readonly botId: string;
	readonly channelId: string;
	readonly bucketName: string;
	/** ARN of the pi-durable session table, for example `arn:aws:dynamodb:us-east-1:111122223333:table/conversations`. */
	readonly conversationsTableArn: string;
};

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_TABLE_ARN = /^arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]+$/;

function requireSafe(pattern: RegExp, value: string, what: string): void {
	if (!pattern.test(value)) {
		throw new Error(`The ${what} contains characters that could widen a policy or is empty.`);
	}
}

/**
 * The IAM session policy that confines a container's storage credentials to one conversation session: the S3 objects
 * under that session's `conversations/<storage>/` prefix, and the DynamoDB items whose partition key is that session's
 * `PI#<storage>`. Nothing is granted on any other prefix, key, table or bucket.
 *
 * Identifiers that carry IAM wildcards, policy variables or the key separator are refused, because they could widen the
 * match or make one session's key a prefix of another's.
 *
 * @param scope The session and its stores.
 * @returns The policy as data. The control plane passes it to STS when it starts the container; nothing here calls AWS.
 * @throws Error When an identifier is empty or unsafe to embed in a policy.
 */
export function buildSessionPolicy(scope: SessionScope): SessionPolicyDocument {
	for (const [what, value] of [
		["tenant id", scope.tenantId],
		["bot id", scope.botId],
		["channel id", scope.channelId],
	] as const) {
		requireSafe(SAFE_IDENTIFIER, value, what);
	}
	requireSafe(SAFE_BUCKET, scope.bucketName, "bucket name");
	requireSafe(SAFE_TABLE_ARN, scope.conversationsTableArn, "table ARN");
	const storageId = storageIdFor(scope.tenantId, scope.botId, scope.channelId);
	const sessionPrefix = commitPrefix(storageId).replace(/commits\/$/, "");
	const bucketArn = `arn:aws:s3:::${scope.bucketName}`;
	return {
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "SessionObjects",
				Effect: "Allow",
				Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
				Resource: [`${bucketArn}/${sessionPrefix}*`],
			},
			{
				Sid: "SessionObjectListing",
				Effect: "Allow",
				Action: ["s3:ListBucket"],
				Resource: [bucketArn],
				Condition: { StringLike: { "s3:prefix": [`${sessionPrefix}*`] } },
			},
			{
				Sid: "SessionItems",
				Effect: "Allow",
				Action: [
					"dynamodb:GetItem",
					"dynamodb:PutItem",
					"dynamodb:UpdateItem",
					"dynamodb:DeleteItem",
					"dynamodb:Query",
					"dynamodb:TransactWriteItems",
				],
				Resource: [scope.conversationsTableArn, `${scope.conversationsTableArn}/index/*`],
				Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`PI#${storageId}`] } },
			},
		],
	};
}
