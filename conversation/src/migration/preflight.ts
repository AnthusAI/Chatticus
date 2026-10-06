import { type AttributeValue, type DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";

/** One queue the pre-flight must find empty and idle. */
export type PreflightQueue = { readonly name: string; readonly url: string };

/** What the pre-flight reads: the Messaging table and the queues, through injected AWS clients. */
export type PreflightDependencies = {
	readonly dynamo: DynamoDBClient;
	readonly sqs: SQSClient;
	readonly messagingTableName: string;
	readonly queues: readonly PreflightQueue[];
	readonly now: () => Date;
};

/** A turn that has not finished. */
export type PreflightActiveTurn = { readonly tenantId: string; readonly turnId: string; readonly status: string };

/** A computer whose host start lease has not yet expired. */
export type PreflightHostStart = { readonly tenantId: string; readonly computerId: string; readonly leaseExpiresAt: string };

/** The message counts of one queue. */
export type PreflightQueueState = {
	readonly name: string;
	readonly url: string;
	readonly visible: number;
	readonly notVisible: number;
	readonly delayed: number;
};

/** The pre-flight result; `ok` is true only when nothing is active, queued, in flight or starting. */
export type PreflightReport = {
	readonly ok: boolean;
	readonly activeTurns: readonly PreflightActiveTurn[];
	readonly queues: readonly PreflightQueueState[];
	readonly hostStartsInFlight: readonly PreflightHostStart[];
};

async function scanAll(
	dynamo: DynamoDBClient,
	tableName: string,
	filterExpression: string,
	names: Record<string, string>,
	values: Record<string, AttributeValue>,
): Promise<Record<string, AttributeValue>[]> {
	const items: Record<string, AttributeValue>[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await dynamo.send(
			new ScanCommand({
				TableName: tableName,
				FilterExpression: filterExpression,
				ExpressionAttributeNames: names,
				ExpressionAttributeValues: values,
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		items.push(...(page.Items ?? []));
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return items;
}

async function unfinishedTurns(deps: PreflightDependencies): Promise<PreflightActiveTurn[]> {
	const items = await scanAll(
		deps.dynamo,
		deps.messagingTableName,
		"#sk = :meta AND contains(#pk, :marker) AND (#status = :active OR #status = :reconciling)",
		{ "#sk": "sk", "#pk": "pk", "#status": "status" },
		{
			":meta": { S: "meta" },
			":marker": { S: "#turn#" },
			":active": { S: "active" },
			":reconciling": { S: "reconciling" },
		},
	);
	return items.map((item) => ({
		tenantId: item.tenant_id?.S ?? "",
		turnId: item.turn_id?.S ?? "",
		status: item.status?.S ?? "",
	}));
}

async function hostStartsInFlight(deps: PreflightDependencies): Promise<PreflightHostStart[]> {
	const nowSeconds = Math.floor(deps.now().getTime() / 1000);
	const items = await scanAll(
		deps.dynamo,
		deps.messagingTableName,
		"#sk = :meta AND contains(#pk, :marker) AND #lease > :now",
		{ "#sk": "sk", "#pk": "pk", "#lease": "host_start_lease_expires_at" },
		{ ":meta": { S: "meta" }, ":marker": { S: "#computer#" }, ":now": { N: String(nowSeconds) } },
	);
	return items.map((item) => ({
		tenantId: item.tenant_id?.S ?? "",
		computerId: item.computer_id?.S ?? "",
		leaseExpiresAt: new Date(Number(item.host_start_lease_expires_at?.N ?? "0") * 1000).toISOString(),
	}));
}

async function queueState(sqs: SQSClient, queue: PreflightQueue): Promise<PreflightQueueState> {
	const response = await sqs.send(
		new GetQueueAttributesCommand({
			QueueUrl: queue.url,
			AttributeNames: [
				"ApproximateNumberOfMessages",
				"ApproximateNumberOfMessagesNotVisible",
				"ApproximateNumberOfMessagesDelayed",
			],
		}),
	);
	const attributes = response.Attributes ?? {};
	return {
		name: queue.name,
		url: queue.url,
		visible: Number(attributes.ApproximateNumberOfMessages ?? "0"),
		notVisible: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? "0"),
		delayed: Number(attributes.ApproximateNumberOfMessagesDelayed ?? "0"),
	};
}

/**
 * Check that the system is quiet enough to flip: no unfinished turn (active or reconciling), every queue empty with
 * nothing in flight or delayed, and no computer host start whose lease is still running.
 *
 * @param deps Injected clients, the Messaging table, the queues and the clock.
 * @returns The report; `ok` is false when any condition fails.
 */
export async function runPreflight(deps: PreflightDependencies): Promise<PreflightReport> {
	const activeTurns = await unfinishedTurns(deps);
	const queues: PreflightQueueState[] = [];
	for (const queue of deps.queues) queues.push(await queueState(deps.sqs, queue));
	const startsInFlight = await hostStartsInFlight(deps);
	const queuesIdle = queues.every((state) => state.visible === 0 && state.notVisible === 0 && state.delayed === 0);
	return {
		ok: activeTurns.length === 0 && queuesIdle && startsInFlight.length === 0,
		activeTurns,
		queues,
		hostStartsInFlight: startsInFlight,
	};
}

/** The environment variables that name the queues, by the name the report gives each. */
export const PREFLIGHT_QUEUE_VARIABLES = [
	["TurnRuns", "CHATTICUS_TURN_RUNS_QUEUE_URL"],
	["TurnProbes", "CHATTICUS_TURN_PROBES_QUEUE_URL"],
	["ComputerStartJobs", "CHATTICUS_COMPUTER_STARTS_QUEUE_URL"],
	["TurnJobs", "CHATTICUS_LEGACY_TURN_JOBS_QUEUE_URL"],
	["ComputerTurnJobs", "CHATTICUS_LEGACY_COMPUTER_TURN_JOBS_QUEUE_URL"],
] as const;

/**
 * Read the pre-flight inputs from the environment.
 *
 * @param environment Variables; `CHATTICUS_MESSAGING_TABLE` and every queue variable are required.
 * @returns The table and queues.
 * @throws Error Naming the first missing or empty variable.
 */
export function preflightInputsFromEnvironment(environment: Record<string, string | undefined>): {
	messagingTableName: string;
	queues: PreflightQueue[];
} {
	const required = (name: string): string => {
		const value = (environment[name] ?? "").trim();
		if (value === "") throw new Error(`${name} is required.`);
		return value;
	};
	return {
		messagingTableName: required("CHATTICUS_MESSAGING_TABLE"),
		queues: PREFLIGHT_QUEUE_VARIABLES.map(([name, variable]) => ({ name, url: required(variable) })),
	};
}
