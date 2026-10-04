import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	createRegistry,
	Harness,
	ROOT_CONVERSATION_ID,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { IndexedStorage } from "../../src/indexed-storage.ts";
import { extensions } from "../../src/owner.ts";

const context = BACKGROUND_CONTEXT;
const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.BUCKET_NAME!;
const MODEL = { provider: "openai", modelId: process.env.MODEL_ID ?? "gpt-5-nano" } as const;
const processStartedAt = Date.now();
let invocationCount = 0;

type Call = { command: string; milliseconds: number; capacityUnits?: number; error?: string; reasons?: string };
let calls: Call[] = [];
const fault = { dropTransactions: 0, skipTransactions: 0, errorName: "TimeoutError", dropped: 0 };

const READ_COMMANDS = new Set(["QueryCommand", "GetItemCommand", "BatchGetItemCommand"]);

function instrument<T extends DynamoDBClient | S3Client>(client: T, ddb: boolean): T {
	(client.middlewareStack as unknown as { add: (middleware: unknown, options: unknown) => void }).add(
		(next: (args: { input: unknown }) => Promise<{ output: unknown }>, middlewareContext: { commandName?: string }) => async (args: { input: unknown }) => {
			const command = middlewareContext.commandName ?? "unknown";
			const input = args.input as Record<string, unknown>;
			if (ddb) input.ReturnConsumedCapacity = "TOTAL";
			const started = performance.now();
			try {
				const result = await next(args);
				const consumed = (result.output as { ConsumedCapacity?: unknown }).ConsumedCapacity;
				const list = Array.isArray(consumed) ? consumed : consumed === undefined ? [] : [consumed];
				const units = list.reduce((sum: number, each: { CapacityUnits?: number }) => sum + (each.CapacityUnits ?? 0), 0);
				calls.push({
					command,
					milliseconds: performance.now() - started,
					...(ddb ? { capacityUnits: units } : {}),
				});
				if (command === "TransactWriteItemsCommand") {
					if (fault.skipTransactions > 0) fault.skipTransactions--;
					else if (fault.dropTransactions > 0) {
						fault.dropTransactions--;
						fault.dropped++;
						throw Object.assign(new Error("simulated lost response"), { name: fault.errorName });
					}
				}
				return result;
			} catch (error) {
				const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
				calls.push({
					command,
					milliseconds: performance.now() - started,
					error: (error as Error).name,
					...(reasons ? { reasons: reasons.map((reason) => reason.Code ?? "None").join(",") } : {}),
				});
				throw error;
			}
		},
		{ step: "initialize", name: "spikeInstrument" },
	);
	return client;
}

const dynamo = instrument(new DynamoDBClient({ region: REGION, maxAttempts: 1 }), true);
const s3 = instrument(new S3Client({ region: REGION, maxAttempts: 1 }), false);
let keyLoaded: number | undefined;

async function loadKey(): Promise<number> {
	if (keyLoaded !== undefined) return 0;
	const started = performance.now();
	const response = await new SSMClient({ region: REGION }).send(
		new GetParameterCommand({ Name: process.env.OPENAI_API_KEY_PARAMETER!, WithDecryption: true }),
	);
	process.env.OPENAI_API_KEY = response.Parameter!.Value!;
	keyLoaded = Date.now();
	return performance.now() - started;
}

const percentile = (values: number[], fraction: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};
const round = (value: number) => Math.round(value * 10) / 10;

function summarizeCalls(from: Call[]) {
	const byCommand: Record<string, { count: number; capacityUnits: number; errors: number; p50: number; p95: number }> = {};
	for (const name of new Set(from.map((call) => call.command))) {
		const each = from.filter((call) => call.command === name);
		byCommand[name] = {
			count: each.length,
			capacityUnits: round(each.reduce((sum, call) => sum + (call.capacityUnits ?? 0), 0)),
			errors: each.filter((call) => call.error !== undefined).length,
			p50: round(percentile(each.map((call) => call.milliseconds), 0.5)),
			p95: round(percentile(each.map((call) => call.milliseconds), 0.95)),
		};
	}
	const sum = (predicate: (call: Call) => boolean) =>
		round(from.filter(predicate).reduce((total, call) => total + (call.capacityUnits ?? 0), 0));
	return {
		byCommand,
		readCapacityUnits: sum((call) => READ_COMMANDS.has(call.command)),
		writeCapacityUnits: sum((call) => !READ_COMMANDS.has(call.command) && call.capacityUnits !== undefined),
		s3Puts: from.filter((call) => call.command === "PutObjectCommand").length,
		s3Gets: from.filter((call) => call.command === "GetObjectCommand").length,
		s3Deletes: from.filter((call) => call.command === "DeleteObjectCommand").length,
	};
}

const openStorage = (storageId: string, fence: number | undefined) =>
	IndexedStorage.open({ client: dynamo, s3, tableName: TABLE, bucket: BUCKET, storageId, fence });

async function runTurn(kind: "plain" | "tool") {
	const storageId = `spike#bot-ada#${randomUUID().slice(0, 8)}`;
	const wall = performance.now();
	await IndexedStorage.claimOwnership({ client: dynamo, tableName: TABLE, storageId, fence: 1 });
	const storage = await openStorage(storageId, 1);
	const models = createModels();
	models.setProvider(openaiProvider());
	const registry = createRegistry();
	for (const extension of extensions({ storageId, fence: 1, name: "lambda", capability: "computer" })) {
		registry.install(extension);
	}
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	const setupCalls = calls.length;
	const setupMeter = storage.meter.snapshot();
	const setupMs = performance.now() - wall;
	const turnStarted = performance.now();
	const content =
		kind === "plain"
			? "Name three primary colours. One line."
			: "Use run_terminal to run `ls /srv`, then report the output in one line.";
	const submission = await root.submit({ type: "input", content, requestId: randomUUID() }, context);
	const settled = await submission.wait(context);
	const turnMs = performance.now() - turnStarted;
	await harness.close(context);
	const turnCalls = calls.slice(setupCalls);
	const meter = storage.meter.snapshot();
	const commits = storage.measurements.filter((each) => each.rejected === undefined);
	return {
		kind,
		status: settled.status,
		setupMilliseconds: round(setupMs),
		turnMilliseconds: round(turnMs),
		openCalls: summarizeCalls(calls.slice(0, setupCalls)),
		turn: summarizeCalls(turnCalls),
		commits: commits.length,
		commitMilliseconds: commits.map((each) => round(each.milliseconds)),
		commitAttempts: commits.map((each) => (each as { transactionAttempts?: number }).transactionAttempts ?? 1),
		meterEstimateTurn: {
			writeRequestUnits: meter.writeRequestUnits - setupMeter.writeRequestUnits,
			readRequestUnits: meter.readRequestUnits - setupMeter.readRequestUnits,
			s3Puts: meter.s3Puts - setupMeter.s3Puts,
			s3Gets: meter.s3Gets - setupMeter.s3Gets,
			dynamoRequests: meter.dynamoRequests - setupMeter.dynamoRequests,
		},
		meterEstimateTotal: meter,
	};
}

async function lostResponse(errorName: string, skip: number) {
	fault.dropTransactions = 1;
	fault.skipTransactions = skip;
	fault.errorName = errorName;
	fault.dropped = 0;
	const result = await runTurn("plain");
	const attempts = result.commitAttempts;
	const meta = result.commits;
	const transactCalls = result.turn.byCommand.TransactWriteItemsCommand;
	fault.dropTransactions = 0;
	return {
		injectedErrorName: errorName,
		dropped: fault.dropped,
		turnStatus: result.status,
		committedCommits: meta,
		commitsThatNeededMoreThanOneAttempt: attempts.filter((each) => each > 1).length,
		transactAttemptsPerCommit: attempts,
		transactionRequestsSent: transactCalls?.count,
		transactionErrors: transactCalls?.errors,
		extraMetaReadsAfterError: undefined as number | undefined,
	};
}

async function conflictTrials(trials: number) {
	const outcomes: Record<string, unknown>[] = [];
	for (let trial = 0; trial < trials; trial++) {
		const storageId = `spike#conflict#${randomUUID().slice(0, 8)}`;
		const setup = await openStorage(storageId, undefined);
		await setup.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		await IndexedStorage.claimOwnership({ client: dynamo, tableName: TABLE, storageId, fence: 5 });
		const unfenced = await openStorage(storageId, undefined);
		const fenced = await openStorage(storageId, 5);
		const [idA, idB] = await Promise.all([unfenced.mintId(), fenced.mintId()]);
		const write = (id: number, who: string): StorageWrite[] => [
			{ type: "entry", value: { id: id as never, conversationId: ROOT_CONVERSATION_ID, kind: "spike.conflict", data: { who } } },
		];
		const before = calls.length;
		const settled = await Promise.allSettled([
			unfenced.commit(write(idA, "A-unfenced"), context),
			fenced.commit(write(idB, "B-fenced"), context),
		]);
		const verify = await openStorage(storageId, undefined);
		const trialCalls = calls.slice(before);
		outcomes.push({
			trial,
			A: settled[0].status === "fulfilled" ? "committed" : `${(settled[0].reason as Error).name}: ${(settled[0].reason as Error).message.slice(0, 80)}`,
			B: settled[1].status === "fulfilled" ? "committed" : `${(settled[1].reason as Error).name}: ${(settled[1].reason as Error).message.slice(0, 80)}`,
			committedCount: settled.filter((each) => each.status === "fulfilled").length,
			ownershipLostCount: settled.filter((each) => each.status === "rejected" && (each.reason as Error).name === "OwnershipLost").length,
			transactionErrors: trialCalls.filter((call) => call.command === "TransactWriteItemsCommand" && call.error).map((call) => `${call.error}[${call.reasons ?? ""}]`),
			transactionsSent: trialCalls.filter((call) => call.command === "TransactWriteItemsCommand").length,
			finalSeq: (verify as unknown as { seq: number }).seq,
		});
	}
	return outcomes;
}

export async function handler(event: { action: string; kind?: "plain" | "tool"; errorName?: string; skip?: number; trials?: number }) {
	const started = performance.now();
	invocationCount++;
	const cold = invocationCount === 1;
	calls = [];
	const ssmMilliseconds = await loadKey();
	let result: unknown;
	if (event.action === "turn") result = await runTurn(event.kind ?? "plain");
	else if (event.action === "lost-response") result = await lostResponse(event.errorName ?? "TimeoutError", event.skip ?? 2);
	else if (event.action === "conflict") result = await conflictTrials(event.trials ?? 20);
	else throw new Error(`unknown action ${event.action}`);
	return {
		cold,
		invocationCount,
		processAgeMilliseconds: Date.now() - processStartedAt,
		ssmMilliseconds: round(ssmMilliseconds),
		handlerMilliseconds: round(performance.now() - started),
		heapUsedMB: round(process.memoryUsage().rss / 1048576),
		result,
	};
}
