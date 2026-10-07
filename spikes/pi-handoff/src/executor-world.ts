/**
 * Wiring for the executor scenario: the same stores the TurnExecutor Lambda builds in conversation/src/lambdas/turn-executor.ts,
 * over moto, with the three queues replaced by recorders (SQS does not exist here). Used by the owner processes and by
 * the seeding coordinator.
 */
import { randomUUID } from "node:crypto";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { DynamoBudgetStore } from "../../../conversation/src/budget/budget-store.ts";
import { createBot } from "../../../conversation/src/domain/bots.ts";
import { createChannel } from "../../../conversation/src/domain/channels.ts";
import type { ComputerStartJob, ComputerStartQueue } from "../../../conversation/src/domain/computer-start.ts";
import { type MessageDependencies, postMessage } from "../../../conversation/src/domain/messages.ts";
import type { TurnProbeQueue, TurnRunJob, TurnRunQueue, TurnRunVisibility } from "../../../conversation/src/domain/turn-admission.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../../../conversation/src/domain/workers.ts";
import { VendorPriceBook } from "../../../conversation/src/ledger/vendor-ledger.ts";
import type { CommitObject } from "../../../conversation/src/storage/indexed-storage.ts";
import { MessageBodyCache } from "../../../conversation/src/pi/message-cache.ts";
import { DynamoComputerActionStore } from "../../../conversation/src/store/action-store.ts";
import { DynamoMessagingStore } from "../../../conversation/src/store/dynamo-messaging-store.ts";
import { DynamoTurnAdmission } from "../../../conversation/src/store/turn-admission-store.ts";
import { DynamoTurnControlStore } from "../../../conversation/src/store/turn-store.ts";
import type { ExecutorDeps } from "../../../conversation/src/turn/types.ts";
import { dynamoClient, journal, MESSAGING_TABLE, PI_BUCKET, PI_TABLE, s3Client } from "./common.ts";

export const TENANT_ID = "spike-tenant";
export const USER_ID = "ryan";

/** Queues that write to the journal instead of SQS. */
export function recordingQueues(owner: string): {
	turnRuns: TurnRunQueue;
	turnProbes: TurnProbeQueue;
	runVisibility: TurnRunVisibility;
	computerStarts: ComputerStartQueue;
	runJobs: TurnRunJob[];
} {
	const runJobs: TurnRunJob[] = [];
	return {
		runJobs,
		turnRuns: {
			async enqueue(job) {
				runJobs.push(job);
				journal(owner, "sqs.TurnRuns.send", { turnId: job.turnId });
			},
		},
		turnProbes: {
			async send(message, delaySeconds) {
				journal(owner, "sqs.TurnProbes.send", { turnId: message.turnId, kind: message.kind, delaySeconds });
			},
		},
		runVisibility: { async extend() {} },
		computerStarts: {
			async enqueue(job: ComputerStartJob) {
				journal(owner, "sqs.ComputerStarts.send", { turnId: job.turnId, computerId: job.computerId });
			},
		},
	};
}

/**
 * Executor dependencies built the way the Lambda builds them: Dynamo stores, one S3 client, a model collection.
 *
 * @param owner Owner label for the journal.
 * @param models The model collection (scripted or the OpenAI provider).
 * @param model Model choice.
 * @param remainingMilliseconds The Lambda remaining-time probe; absent for an owner whose time is unbounded.
 */
export function buildExecutorDeps(
	owner: string,
	models: Models,
	model: { provider: string; modelId: string; thinkingLevel: "off" | "minimal" },
	remainingMilliseconds?: () => number,
): ExecutorDeps & { runJobs: TurnRunJob[] } {
	const client = dynamoClient();
	const queues = recordingQueues(owner);
	return {
		turns: { store: new DynamoTurnControlStore(client, MESSAGING_TABLE), clock: { now: () => new Date() }, ids: { next: () => randomUUID() } },
		messaging: new DynamoMessagingStore(client, MESSAGING_TABLE),
		client,
		s3: s3Client(),
		messagingTableName: MESSAGING_TABLE,
		conversationsTableName: PI_TABLE,
		piSessionsBucket: PI_BUCKET,
		models,
		model,
		ledger: { client, tableName: MESSAGING_TABLE, prices: new VendorPriceBook(), now: () => new Date() },
		workerLabel: owner,
		turnRuns: queues.turnRuns,
		turnProbes: queues.turnProbes,
		runVisibility: queues.runVisibility,
		...(remainingMilliseconds === undefined ? {} : { remainingMilliseconds }),
		computer: {
			actions: new DynamoComputerActionStore(client, MESSAGING_TABLE),
			computerStarts: queues.computerStarts,
			rollups: new DynamoBudgetStore(client, MESSAGING_TABLE),
			environment: "spike",
			heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
		},
		runJobs: queues.runJobs,
	};
}

/** A model collection that serves one scripted provider. */
export function scriptedModels(provider: Parameters<Models["setProvider"]>[0]): Models {
	const models = createModels();
	models.setProvider(provider);
	return models;
}

/**
 * Seed one bot and its direct channel, then post messages through the production admission path.
 *
 * @param bodies Messages to post, in order; each starts a turn (the earlier turn must have ended).
 */
export async function seedBotAndChannel(): Promise<{ botId: string; channelId: string; deps: MessageDependencies }> {
	const client = dynamoClient();
	const s3 = s3Client();
	const store = new DynamoMessagingStore(client, MESSAGING_TABLE);
	const ids = { next: () => randomUUID() };
	const queues = recordingQueues("coordinator");
	const bot = await createBot(TENANT_ID, `Ada-${Date.now()}`, { creatorUserId: USER_ID }, { store, ids });
	const channel = await createChannel(TENANT_ID, USER_ID, [bot.botId], { kind: "direct" }, { store, ids });
	const deps: MessageDependencies = {
		store,
		ids,
		clock: { now: () => new Date() },
		mailbox: { client, tableName: MESSAGING_TABLE },
		turns: new DynamoTurnAdmission(client, MESSAGING_TABLE),
		turnRuns: queues.turnRuns,
		turnProbes: queues.turnProbes,
		listing: {
			client,
			s3,
			messagingTableName: MESSAGING_TABLE,
			conversationsTableName: PI_TABLE,
			bucket: PI_BUCKET,
			commitCache: new MessageBodyCache<Promise<CommitObject>>(),
		},
	};
	return { botId: bot.botId, channelId: channel.channelId, deps };
}

/**
 * Post one human message addressed to the bot. Returns the run job the front door would have put on SQS.
 *
 * @param deps Message dependencies from `seedBotAndChannel`.
 * @param channelId Channel.
 * @param botId Bot.
 * @param body Message text.
 */
export async function postHumanMessage(deps: MessageDependencies, channelId: string, botId: string, body: string): Promise<{ tenantId: string; turnId: string; botId: string }> {
	const result = await postMessage(deps, {
		tenantId: TENANT_ID,
		channelId,
		authorKind: "human",
		authorId: USER_ID,
		body,
		addressedToBotId: botId,
		idempotencyKey: null,
	});
	if (result.turnId === null) throw new Error("The message did not start a turn.");
	return { tenantId: TENANT_ID, turnId: result.turnId, botId };
}
