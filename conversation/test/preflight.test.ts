import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DeleteItemCommand, DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
	CreateQueueCommand,
	ReceiveMessageCommand,
	SendMessageCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { beforeAll, describe, expect, it } from "vitest";
import { createMessagingTable } from "../features-support/messaging-table.ts";
import {
	PREFLIGHT_QUEUE_VARIABLES,
	type PreflightQueue,
	preflightInputsFromEnvironment,
	runPreflight,
} from "../src/migration/preflight.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const sqs = new SQSClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const now = new Date("2026-09-10T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

const tableName = `preflight-${randomUUID()}`;
let queues: PreflightQueue[] = [];

async function createQueues(): Promise<PreflightQueue[]> {
	const prefix = randomUUID();
	const created: PreflightQueue[] = [];
	for (const [name] of PREFLIGHT_QUEUE_VARIABLES) {
		const response = await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}-${name}` }));
		created.push({ name, url: response.QueueUrl! });
	}
	return created;
}

const preflight = () => runPreflight({ dynamo, sqs, messagingTableName: tableName, queues, now: () => now });

async function putTurn(turnId: string, status: string): Promise<void> {
	await dynamo.send(
		new PutItemCommand({
			TableName: tableName,
			Item: {
				pk: { S: `anthus#turn#${turnId}` },
				sk: { S: "meta" },
				tenant_id: { S: "anthus" },
				turn_id: { S: turnId },
				status: { S: status },
			},
		}),
	);
}

async function putComputer(computerId: string, leaseEpochSeconds: number | null): Promise<void> {
	await dynamo.send(
		new PutItemCommand({
			TableName: tableName,
			Item: {
				pk: { S: `anthus#computer#${computerId}` },
				sk: { S: "meta" },
				tenant_id: { S: "anthus" },
				computer_id: { S: computerId },
				...(leaseEpochSeconds === null ? {} : { host_start_lease_expires_at: { N: String(leaseEpochSeconds) } }),
			},
		}),
	);
}

async function removeEverything(): Promise<void> {
	const page = await dynamo.send(new ScanCommand({ TableName: tableName }));
	for (const item of page.Items ?? []) {
		await dynamo.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: item.pk!, sk: item.sk! } }));
	}
}

beforeAll(async () => {
	await createMessagingTable(dynamo, tableName);
});

describe("preflight", () => {
	it("passes when nothing is active, every queue is quiet and no host start is running", async () => {
		await removeEverything();
		queues = await createQueues();
		await putTurn("done", "completed");
		await putTurn("broken", "failed");
		await putComputer("idle", null);
		await putComputer("expired", nowSeconds - 60);
		const report = await preflight();
		expect(report.ok).toBe(true);
		expect(report.activeTurns).toEqual([]);
		expect(report.hostStartsInFlight).toEqual([]);
		expect(report.queues.map((state) => state.name)).toEqual(["TurnRuns", "TurnProbes", "ComputerStartJobs", "TurnJobs", "ComputerTurnJobs"]);
		expect(report.queues.every((state) => state.visible === 0 && state.notVisible === 0 && state.delayed === 0)).toBe(true);
	});

	it("fails and names an active turn", async () => {
		await removeEverything();
		queues = await createQueues();
		await putTurn("running", "active");
		const report = await preflight();
		expect(report.ok).toBe(false);
		expect(report.activeTurns).toEqual([{ tenantId: "anthus", turnId: "running", status: "active" }]);
	});

	it("fails and names a turn that is being reconciled", async () => {
		await removeEverything();
		queues = await createQueues();
		await putTurn("recovering", "reconciling");
		const report = await preflight();
		expect(report.ok).toBe(false);
		expect(report.activeTurns).toEqual([{ tenantId: "anthus", turnId: "recovering", status: "reconciling" }]);
	});

	it("fails when any one queue holds a waiting message, naming the queue", async () => {
		for (const [index, [name]] of PREFLIGHT_QUEUE_VARIABLES.entries()) {
			await removeEverything();
			queues = await createQueues();
			await sqs.send(new SendMessageCommand({ QueueUrl: queues[index]!.url, MessageBody: "waiting" }));
			const report = await preflight();
			expect(report.ok, `${name} holding a message`).toBe(false);
			expect(report.queues.filter((state) => state.visible > 0).map((state) => state.name)).toEqual([name]);
		}
	});

	it("fails when a message is in flight and not visible", async () => {
		await removeEverything();
		queues = await createQueues();
		const legacy = queues[3]!;
		await sqs.send(new SendMessageCommand({ QueueUrl: legacy.url, MessageBody: "in flight" }));
		await sqs.send(new ReceiveMessageCommand({ QueueUrl: legacy.url, VisibilityTimeout: 120 }));
		const report = await preflight();
		expect(report.ok).toBe(false);
		const state = report.queues.find((candidate) => candidate.name === "TurnJobs")!;
		expect({ visible: state.visible, notVisible: state.notVisible }).toEqual({ visible: 0, notVisible: 1 });
	});

	it("fails when a message is delayed", async () => {
		await removeEverything();
		queues = await createQueues();
		await sqs.send(new SendMessageCommand({ QueueUrl: queues[0]!.url, MessageBody: "later", DelaySeconds: 60 }));
		const report = await preflight();
		expect(report.ok).toBe(false);
		expect(report.queues[0]!.delayed).toBe(1);
	});

	it("fails and names a computer whose host start lease is still running", async () => {
		await removeEverything();
		queues = await createQueues();
		await putComputer("starting", nowSeconds + 300);
		const report = await preflight();
		expect(report.ok).toBe(false);
		expect(report.hostStartsInFlight).toEqual([
			{ tenantId: "anthus", computerId: "starting", leaseExpiresAt: new Date((nowSeconds + 300) * 1000).toISOString() },
		]);
	});
});

describe("preflightInputsFromEnvironment", () => {
	const complete: Record<string, string> = {
		CHATTICUS_MESSAGING_TABLE: "messaging",
		CHATTICUS_TURN_RUNS_QUEUE_URL: "http://q/runs",
		CHATTICUS_TURN_PROBES_QUEUE_URL: "http://q/probes",
		CHATTICUS_COMPUTER_STARTS_QUEUE_URL: "http://q/starts",
		CHATTICUS_LEGACY_TURN_JOBS_QUEUE_URL: "http://q/turn-jobs",
		CHATTICUS_LEGACY_COMPUTER_TURN_JOBS_QUEUE_URL: "http://q/computer-turn-jobs",
	};

	it("reads the table and all five queues", () => {
		expect(preflightInputsFromEnvironment(complete)).toEqual({
			messagingTableName: "messaging",
			queues: [
				{ name: "TurnRuns", url: "http://q/runs" },
				{ name: "TurnProbes", url: "http://q/probes" },
				{ name: "ComputerStartJobs", url: "http://q/starts" },
				{ name: "TurnJobs", url: "http://q/turn-jobs" },
				{ name: "ComputerTurnJobs", url: "http://q/computer-turn-jobs" },
			],
		});
	});

	it("names whichever variable is missing or empty", () => {
		for (const name of Object.keys(complete)) {
			expect(() => preflightInputsFromEnvironment({ ...complete, [name]: undefined })).toThrow(`${name} is required.`);
			expect(() => preflightInputsFromEnvironment({ ...complete, [name]: " " })).toThrow(`${name} is required.`);
		}
	});
});

describe("preflight command", () => {
	const run = (extra: Record<string, string> = {}) =>
		spawnSync(process.execPath, ["bin/preflight.ts"], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH ?? "",
				AWS_ENDPOINT_URL: endpoint,
				AWS_REGION: "us-east-1",
				AWS_ACCESS_KEY_ID: "test",
				AWS_SECRET_ACCESS_KEY: "test",
				CHATTICUS_MESSAGING_TABLE: tableName,
				...Object.fromEntries(PREFLIGHT_QUEUE_VARIABLES.map(([, variable], index) => [variable, queues[index]!.url])),
				...extra,
			},
		});

	it("prints the JSON report and exits 0 when quiet, 1 when a turn is active", async () => {
		await removeEverything();
		queues = await createQueues();
		const quiet = run();
		expect(quiet.status).toBe(0);
		expect(JSON.parse(quiet.stdout).ok).toBe(true);
		await putTurn("running", "active");
		const busy = run();
		expect(busy.status).toBe(1);
		expect(JSON.parse(busy.stdout).activeTurns).toHaveLength(1);
	});

	it("exits 2 naming a missing variable", async () => {
		await removeEverything();
		queues = await createQueues();
		const result = run({ CHATTICUS_LEGACY_TURN_JOBS_QUEUE_URL: "" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("CHATTICUS_LEGACY_TURN_JOBS_QUEUE_URL is required.");
	});
});
