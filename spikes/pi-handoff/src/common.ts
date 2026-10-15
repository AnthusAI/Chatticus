import { appendFileSync } from "node:fs";
import { Agent } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { commitPrefix } from "../../../conversation/src/storage/storage-support.ts";

/** Moto endpoint shared by every process of the spike. */
export const ENDPOINT = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5622";

/** Test credentials; the spike never reads real ones for AWS. */
export const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };

/** Table and bucket the spike uses for pi-durable storage. */
export const PI_TABLE = "SpikeConversations";
export const PI_BUCKET = "spike-pi-sessions";
export const MESSAGING_TABLE = "SpikeMessaging";

const surface = new Map<string, number>();

/** Every AWS call this process made, as `service Command resource` with a count: the IAM surface the owner needs. */
export function awsSurface(): Record<string, number> {
	return Object.fromEntries([...surface.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function recorded<T extends { middlewareStack: { add: (...arguments_: never[]) => void } }>(client: T, service: string): T {
	(client.middlewareStack as unknown as { add: (middleware: unknown, options: unknown) => void }).add(
		(next: (arguments_: { input: Record<string, unknown> }) => Promise<unknown>, context: { commandName?: string }) =>
			async (arguments_: { input: Record<string, unknown> }) => {
				const input = arguments_.input;
				const resource =
					service === "s3"
						? `${String(input["Bucket"])}/${String(input["Key"] ?? input["Prefix"] ?? "").replace(/^(conversations)\/[^/]+\//, "$1/<storageId>/").replace(/\d{12}-\d{8}/, "<seq>-<fence>")}`
						: String(input["TableName"] ?? (input["TransactItems"] as Array<{ Put?: { TableName?: string }; Update?: { TableName?: string }; ConditionCheck?: { TableName?: string } }> | undefined)?.map((item) => item.Put?.TableName ?? item.Update?.TableName ?? item.ConditionCheck?.TableName)[0] ?? "");
				const key = `${service} ${context.commandName ?? "?"} ${resource}`;
				surface.set(key, (surface.get(key) ?? 0) + 1);
				const startedAt = Date.now();
				const watchdog = setTimeout(() => journal("aws", "request.slow", { call: key, pendingMs: Date.now() - startedAt }), 8_000);
				try {
					return await next(arguments_);
				} catch (error) {
					if (Date.now() - startedAt > 8_000) journal("aws", "request.failed_after_slow", { call: key, error: (error as Error).name });
					throw error;
				} finally {
					clearTimeout(watchdog);
				}
			},
		{ step: "initialize", name: "spikeRecorder" },
	);
	return client;
}

/**
 * Dynamo client against moto, with the SDK retry off as the storage requires.
 *
 * @param endpoint Moto endpoint.
 */
const handlerOptions = (): { requestHandler?: { requestTimeout: number; connectionTimeout: number; httpAgent: Agent } } =>
	process.env.SPIKE_NO_KEEPALIVE === "1"
		? { requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000, httpAgent: new Agent({ keepAlive: false }) } }
		: {};

export const dynamoClient = (endpoint: string = ENDPOINT): DynamoDBClient =>
	recorded(new DynamoDBClient({ endpoint, region: "us-east-1", credentials: CREDENTIALS, maxAttempts: 1, ...handlerOptions() }), "dynamodb");

/**
 * S3 client against moto.
 *
 * @param endpoint Moto endpoint.
 */
export const s3Client = (endpoint: string = ENDPOINT): S3Client =>
	recorded(new S3Client({ endpoint, region: "us-east-1", credentials: CREDENTIALS, forcePathStyle: true, maxAttempts: 1, ...handlerOptions() }), "s3");

/**
 * Append one line to the shared journal that records which owner did what. Every process writes the same file.
 *
 * @param owner Name of the owner process, such as `A` or `B`.
 * @param event What happened.
 * @param data Extra fields.
 */
export function journal(owner: string, event: string, data: Record<string, unknown> = {}): void {
	const path = process.env.SPIKE_JOURNAL;
	const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, owner, event, ...data });
	if (path === undefined) console.log(line);
	else appendFileSync(path, `${line}\n`);
}

/**
 * List the commit objects of one storage as `seq-fence` pairs, in commit order. This shows which fence wrote which commit.
 *
 * @param s3 S3 client.
 * @param storageId Partition identity.
 */
export async function commitObjects(s3: S3Client, storageId: string): Promise<Array<{ seq: number; fence: number }>> {
	const found: Array<{ seq: number; fence: number }> = [];
	let token: string | undefined;
	do {
		const page = await s3.send(
			new ListObjectsV2Command({ Bucket: PI_BUCKET, Prefix: commitPrefix(storageId), ContinuationToken: token }),
		);
		for (const object of page.Contents ?? []) {
			const match = /\/(\d+)-(\d+)\.json$/.exec(object.Key ?? "");
			if (match !== null) found.push({ seq: Number(match[1]), fence: Number(match[2]) });
		}
		token = page.NextContinuationToken;
	} while (token !== undefined);
	return found.sort((left, right) => left.seq - right.seq);
}

/**
 * Collapse commit pairs into fence ranges, for printing.
 *
 * @param commits Output of `commitObjects`.
 */
export function fenceRanges(commits: ReadonlyArray<{ seq: number; fence: number }>): string[] {
	const ranges: string[] = [];
	for (const commit of commits) {
		const last = ranges.length === 0 ? null : /^fence (\d+): seq (\d+)-(\d+)$/.exec(ranges[ranges.length - 1]!);
		if (last !== null && Number(last[1]) === commit.fence) ranges[ranges.length - 1] = `fence ${commit.fence}: seq ${last[2]}-${commit.seq}`;
		else ranges.push(`fence ${commit.fence}: seq ${commit.seq}-${commit.seq}`);
	}
	return ranges;
}
