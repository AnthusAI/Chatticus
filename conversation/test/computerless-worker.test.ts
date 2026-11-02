import { Decimal } from "../src/budget/decimal.ts";
import type { Channel } from "../src/domain/channels.ts";
import type { Turn, TurnControlStore, TurnEvent } from "../src/domain/turns.ts";
import { readEntryBody, readLog } from "../src/pi/channel-log.ts";
import { put as putMailbox, mailboxPartitionKey, mailboxSortKey } from "../src/pi/mailbox.ts";
import type { OwnerSession } from "../src/pi/session.ts";
import { VendorPriceBook } from "../src/ledger/price-book.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../src/turn/types.ts";
import { consumeRunJob } from "../src/turn/executor.ts";
import { InMemoryMessagingStore } from "../features-support/in-memory-messaging-store.ts";
import { ScriptedProvider } from "../features-support/fakes/scripted-provider.ts";
import { memoryOwnerSessionFactory } from "../features-support/memory-owner-session.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { DeleteItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

const tenantId = "papyrus-tenant";
const editorId = "editor-a";
const botId = "editorial-assistant";
const channelId = "editorial-channel";
const turnId = "editorial-turn";
const now = new Date("2026-10-24T12:00:00.000Z");

function makeTurn(): Turn {
	return {
		turnId,
		tenantId,
		channelId,
		botId,
		status: "active",
		promptMessageSeq: 1,
		promptAuthorId: editorId,
		attemptId: null,
		attempt: 0,
		claimedBy: null,
		leaseExpiresAt: null,
		deadlineAt: null,
		recoveryAttempts: 0,
		waitingFor: null,
		waitingSince: null,
		logicalEnqueueIds: [],
		pendingComputerTool: null,
		storageFence: null,
		nextEventSeq: 2,
		terminalReason: null,
		messageSeq: null,
	};
}

function inMemoryTurnControl(turn: Turn): { store: TurnControlStore; events: TurnEvent[] } {
	const events: TurnEvent[] = [{
		eventId: "turn-started",
		tenantId,
		turnId,
		channelId,
		seq: 1,
		kind: "turn.started",
	}];
	const assertOwner = (attemptId: string) => {
		if (turn.attemptId !== attemptId) throw new Error("stale worker attempt");
	};
	const append = (draft: Record<string, unknown>, eventId: string): TurnEvent => {
		const event = { ...draft, eventId, tenantId, turnId, channelId, seq: turn.nextEventSeq++ } as TurnEvent;
		events.push(event);
		return event;
	};
	const store = {
		async getTurn(requestTenantId: string, requestTurnId: string) {
			return requestTenantId === tenantId && requestTurnId === turnId ? turn : null;
		},
		async claimTurn(request: { attemptId: string; claimedBy: string | null; leaseExpiresAt: Date; deadlineAt: Date }) {
			if (turn.status !== "active" || turn.attemptId !== null) return null;
			Object.assign(turn, { attemptId: request.attemptId, attempt: turn.attempt + 1, claimedBy: request.claimedBy,
				leaseExpiresAt: request.leaseExpiresAt, deadlineAt: request.deadlineAt });
			return turn;
		},
		async renewTurn(request: { attemptId: string; leaseExpiresAt: Date; deadlineAt: Date }) {
			if (turn.status !== "active" || turn.attemptId !== request.attemptId) return null;
			turn.leaseExpiresAt = request.leaseExpiresAt;
			turn.deadlineAt = request.deadlineAt;
			return turn;
		},
		async recordStorageFence(_tenant: string, _id: string, attemptId: string, fence: number) {
			assertOwner(attemptId);
			turn.storageFence = fence;
		},
		async appendEvent(request: { attemptId: string; draft: Record<string, unknown>; eventId: string }) {
			assertOwner(request.attemptId);
			return append(request.draft, request.eventId);
		},
		async beginClosing(_tenant: string, _id: string, attemptId: string) { assertOwner(attemptId); },
		async completeTurn(request: { attemptId: string; messageSeq: number; body: string; eventId: string }) {
			assertOwner(request.attemptId);
			turn.status = "completed";
			turn.messageSeq = request.messageSeq;
			return append({ kind: "turn.completed", messageSeq: request.messageSeq, body: request.body }, request.eventId);
		},
		async failTurn(request: { attemptId: string; reason: string; eventId: string }) {
			assertOwner(request.attemptId);
			turn.status = "failed";
			turn.terminalReason = request.reason;
			return append({ kind: "turn.failed", body: request.reason }, request.eventId);
		},
		async listEvents(_tenant: string, _id: string, after: number) { return events.filter((event) => event.seq > after); },
		async getGrant() { return null; },
	} as unknown as TurnControlStore;
	return { store, events };
}

function inMemoryDynamo() {
	const items = new Map<string, Record<string, any>>();
	const sequences = new Map<string, number>();
	const client = {
		async send(command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
			if (command.constructor.name === UpdateItemCommand.name) {
				const key = command.input.Key as Record<string, { S?: string }>;
				const partition = `${key.pk?.S}\0${key.sk?.S}`;
				const next = (sequences.get(partition) ?? 1) + 1;
				sequences.set(partition, next);
				return { Attributes: { next_seq: { N: String(next) } } };
			}
			if (command.constructor.name === PutItemCommand.name) {
				const item = command.input.Item as Record<string, any>;
				items.set(`${item.pk?.S}\0${item.sk?.S}`, structuredClone(item));
				return {};
			}
			if (command.constructor.name === QueryCommand.name) {
				const values = command.input.ExpressionAttributeValues as Record<string, { S?: string }>;
				const partition = values[":pk"]?.S;
				const after = values[":after"]?.S ?? "";
				return { Items: [...items.values()].filter((item) => item.pk?.S === partition && item.sk?.S > after) };
			}
			if (command.constructor.name === DeleteItemCommand.name) {
				const key = command.input.Key as Record<string, { S?: string }>;
				items.delete(`${key.pk?.S}\0${key.sk?.S}`);
				return {};
			}
			if (command.constructor.name === TransactWriteItemsCommand.name) return {};
			throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
		},
	};
	return { client: client as never, items, sequences };
}

describe("the reusable computerless worker", () => {
	it("persists one reply and completion, reloads it, and acknowledges a duplicate job without rerunning the model", async () => {
		const messaging = new InMemoryMessagingStore();
		const bot = { tenantId, botId, name: "Editorial Assistant", memory: {} };
		const channel: Channel = {
			channelId,
			tenantId,
			kind: "direct",
			name: null,
			participants: [{ kind: "human", actorId: editorId }, { kind: "bot", actorId: botId }],
			nextSeq: 1,
		};
		await messaging.putBot(bot, false);
		await messaging.putChannel(channel);
		const turn = makeTurn();
		const turnControl = inMemoryTurnControl(turn);
		const dynamo = inMemoryDynamo();
		dynamo.sequences.set(`${tenantId}#channel#${channelId}\0meta`, 2);
		let id = 0;
		const ids = { next: () => `id-${++id}` };
		const clock = { now: () => new Date(now) };
		const mailbox = { client: dynamo.client, tableName: "in-memory" };
		await putMailbox(mailbox, {
			tenantId,
			botId,
			channelId,
			seq: 1,
			messageId: "prompt-message",
			authorKind: "human",
			authorId: editorId,
			addressedToBotId: botId,
			body: "Draft an update",
			createdAt: now.toISOString(),
		});
		const scripted = new ScriptedProvider("openai", "computerless-test-model").reply("The draft is ready.");
		const models = createModels();
		models.setProvider(scripted.provider);
		const prices = new VendorPriceBook("test-price-book");
		prices.register("openai", scripted.modelId, {
			inputPerMillionUsd: Decimal.parse("1"),
			outputPerMillionUsd: Decimal.parse("2"),
		});
		const sessions: OwnerSession[] = [];
		const deps = {
			turns: { store: turnControl.store, clock, ids },
			messaging,
			client: dynamo.client,
			s3: {} as never,
			messagingTableName: "in-memory",
			conversationsTableName: "in-memory",
			piSessionsBucket: "in-memory",
			models,
			model: { provider: "openai", modelId: scripted.modelId, thinkingLevel: "off" as const },
			ledger: { client: dynamo.client, tableName: "in-memory", prices, now: clock.now },
			ownerKind: "lambda" as const,
			executionProfile: "computerless" as const,
			sessionFactory: memoryOwnerSessionFactory((session) => sessions.push(session)),
			turnRuns: { async enqueue() {} },
			turnProbes: { async send() {} },
			runVisibility: { async extend() {} },
			computer: {} as never,
			tuning: { renewIntervalMilliseconds: 60_000, mailboxPollMilliseconds: 2 },
		} satisfies ExecutorDeps;
		const job: TurnExecutionJob = { tenantId, turnId, botId };
		let acknowledgements = 0;
		const acknowledge = async () => { acknowledgements += 1; };

		await expect(consumeRunJob(job, deps, acknowledge)).resolves.toBe("done");
		expect(turn.status).toBe("completed");
		expect(turnControl.events.filter((event) => event.kind === "turn.completed")).toHaveLength(1);
		expect(turnControl.events.find((event) => event.kind === "turn.completed")).toMatchObject({ body: "The draft is ready.", messageSeq: 2 });
		expect(acknowledgements).toBe(1);
		expect(scripted.callCount).toBe(1);
		expect(sessions).toHaveLength(1);
		const log = await readLog(sessions[0]!.storage);
		const reply = log.find((line) => line.authorKind === "bot");
		expect(reply).toBeDefined();
		expect(await readEntryBody(sessions[0]!.storage, reply!.entryId)).toBe("The draft is ready.");

		await expect(consumeRunJob(job, deps, acknowledge)).resolves.toBe("lost");
		expect(acknowledgements).toBe(2);
		expect(scripted.callCount).toBe(1);
		expect((await readLog(sessions[0]!.storage)).filter((line) => line.authorKind === "bot")).toHaveLength(1);
		expect(turnControl.events.filter((event) => event.kind === "turn.completed")).toHaveLength(1);
		expect(dynamo.items.has(`${mailboxPartitionKey(tenantId, botId, channelId)}\0${mailboxSortKey(1)}`)).toBe(false);
		await sessions[0]!.close();
	});
});
