import assert from "node:assert/strict";
import { type DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createModels } from "@earendil-works/pi-ai/models";
import { VendorPriceBook, type VendorLedgerDependencies } from "../src/ledger/vendor-ledger.ts";
import type { TurnControlStore, TurnDependencies } from "../src/domain/turns.ts";
import type { TurnRunJob } from "../src/domain/turn-admission.ts";
import { executeTurn } from "../src/turn/executor.ts";
import type { ExecutorDeps, ExecutorTuning, TurnExecutionOutcome } from "../src/turn/types.ts";
import { ScriptedProvider, type ScriptedHold } from "./fakes/scripted-provider.ts";
import { TURN_RUN_QUEUE } from "./front-door.ts";
import { ensurePiStorage } from "./pi-storage.ts";
import type { TurnWatcher } from "./turn-watcher.ts";
import type { ChatticusWorld } from "./world.ts";

/** What a bot answers with when a scenario did not script its answer; the number tells the answers of one scenario apart. */
export const defaultScriptedAnswer = (callNumber: number): string => `Here is my answer number ${callNumber}.`;

/** Matches any default answer. */
export const DEFAULT_SCRIPTED_ANSWER_PATTERN = /^Here is my answer number \d+\.$/;

/** The model id scenarios use unless a step names another. */
export const DEFAULT_SCRIPTED_MODEL_ID = "scripted-model";

/** What is true about the model, its prices and its faults during one scenario. */
export type ModelScenario = {
	readonly scripted: ScriptedProvider;
	readonly outcomes: TurnExecutionOutcome[];
	readonly storeFault: { armed: boolean; broken: boolean };
	readonly runs: Map<string, Promise<TurnExecutionOutcome>>;
	/** The pause the scripted model currently holds a request at, when a scenario set one. */
	hold?: ScriptedHold;
	/** The member watching the turn through server-sent events. */
	watcher?: TurnWatcher;
	/** The execution a step started and has not waited for yet. */
	started?: Promise<TurnExecutionOutcome>;
	/** How the last waited-for execution ended. */
	lastOutcome?: TurnExecutionOutcome;
	/** Lets the superseded execution renew its lease, which is how it learns it lost the turn. */
	openRenewals?: () => void;
	/** The execution that was superseded by a newer attempt. */
	firstAttempt?: Promise<TurnExecutionOutcome>;
};

const scenarios = new WeakMap<ChatticusWorld, ModelScenario>();
const priceBooks = new WeakMap<ChatticusWorld, VendorPriceBook>();

/** The scenario's vendor price book, which the executor and the ledger steps share. */
export function priceBookOf(world: ChatticusWorld): VendorPriceBook {
	let book = priceBooks.get(world);
	if (book === undefined) {
		book = new VendorPriceBook();
		priceBooks.set(world, book);
	}
	return book;
}

/**
 * The scenario's model: a scripted provider standing in for the vendor, created on first use under `modelId`.
 *
 * @param world The scenario world.
 * @param modelId Model the provider serves; only the first call of a scenario may choose it.
 */
export function modelScenarioOf(world: ChatticusWorld, modelId: string = DEFAULT_SCRIPTED_MODEL_ID): ModelScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			scripted: new ScriptedProvider("openai", modelId),
			outcomes: [],
			storeFault: { armed: false, broken: false },
			runs: new Map(),
		};
		scenarios.set(world, scenario);
	}
	assert.equal(scenario.scripted.modelId, modelId, "the scenario's model was already chosen");
	return scenario;
}

/** The scenario's model state when a step has already created it, whatever model it chose; otherwise undefined. */
export const existingModelScenario = (world: ChatticusWorld): ModelScenario | undefined => scenarios.get(world);

/** Whether the scenario has a scripted model yet. */
export const hasModelScenario = (world: ChatticusWorld): boolean => scenarios.has(world);

const TEST_TUNING: Partial<ExecutorTuning> = {
	renewIntervalMilliseconds: 50,
	mailboxPollMilliseconds: 20,
	retry: { maxRetries: 2, baseDelayMilliseconds: 5 },
};

/**
 * A DynamoDB client that behaves like the real one until a scenario arms the store fault: then the next transaction on
 * the conversations table fails without an answer and every later read of that table fails too, which is how a lost
 * response with a failed follow-up check looks to the storage.
 */
function faultableClient(client: DynamoDBClient, fault: ModelScenario["storeFault"], conversationsTable: string): DynamoDBClient {
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property !== "send") return Reflect.get(target, property, receiver);
			return (command: unknown, ...rest: unknown[]) => {
				const tableName = (command as { input?: { TableName?: string } }).input?.TableName;
				const onConversations = tableName === conversationsTable;
				if (fault.armed && command instanceof TransactWriteItemsCommand) {
					const items = (command.input.TransactItems ?? []) as Array<{ Put?: { TableName?: string }; Update?: { TableName?: string } }>;
					const names = items.map((item) => item.Put?.TableName ?? item.Update?.TableName);
					if (names.includes(conversationsTable)) {
						fault.broken = true;
						throw Object.assign(new Error("the table did not answer"), { name: "UnknownTransactionOutcome" });
					}
				}
				if (fault.broken && onConversations && command instanceof GetItemCommand) {
					throw Object.assign(new Error("the table did not answer"), { name: "UnknownTransactionOutcome" });
				}
				return (target.send as (...args: unknown[]) => unknown)(command, ...rest);
			};
		},
	});
}

/**
 * Turn dependencies whose lease renewals wait for a gate. A scenario that moves the fake clock past a lease must decide
 * when the owner's renewal happens; a renewal on a real timer could land between the clock move and the next claim.
 */
function gatedRenewals(turns: TurnDependencies, gate: Promise<void> | undefined): TurnDependencies {
	if (gate === undefined) return turns;
	const store = new Proxy(turns.store, {
		get(target, property, receiver) {
			if (property !== "renewTurn") return Reflect.get(target, property, receiver);
			return async (request: Parameters<TurnControlStore["renewTurn"]>[0]) => {
				await gate;
				return target.renewTurn(request);
			};
		},
	});
	return { ...turns, store };
}

/** The vendor ledger's dependencies for a scenario. */
export function ledgerDependenciesFor(world: ChatticusWorld): VendorLedgerDependencies {
	return {
		client: world.messagingTable.client,
		tableName: world.messagingTable.tableName,
		prices: priceBookOf(world),
		now: () => world.clock.now(),
	};
}

/** The executor's dependencies over the scenario's tables, clock, identifiers and scripted model. */
export async function executorDepsFor(
	world: ChatticusWorld,
	scenario: ModelScenario,
	options: { renewalGate?: Promise<void> } = {},
): Promise<ExecutorDeps> {
	const piStorage = await ensurePiStorage(world);
	const models = createModels();
	models.setProvider(scenario.scripted.provider);
	return {
		turns: gatedRenewals(world.turnDependencies(), options.renewalGate),
		messaging: world.messagingStore(),
		client: faultableClient(world.messagingTable.client, scenario.storeFault, piStorage.tableName),
		s3: piStorage.s3,
		messagingTableName: world.messagingTable.tableName,
		conversationsTableName: piStorage.tableName,
		piSessionsBucket: piStorage.bucket,
		models,
		model: { provider: "openai", modelId: scenario.scripted.modelId, thinkingLevel: "minimal" },
		ledger: ledgerDependenciesFor(world),
		tuning: TEST_TUNING,
	};
}

/**
 * Take the queued run job of a bot off the turn queue, as a consumer would, and start the real executor on it.
 *
 * @returns The promise of the execution's outcome, also recorded on the scenario.
 */
export function startBotTurn(
	world: ChatticusWorld,
	botName: string,
	modelId: string = DEFAULT_SCRIPTED_MODEL_ID,
	options: { renewalGate?: Promise<void> } = {},
): Promise<TurnExecutionOutcome> {
	const bot = world.botsByName?.get(botName);
	assert.ok(bot, `Bot ${botName} not found`);
	const queued = world.queues.take(TURN_RUN_QUEUE, (body) => (body as TurnRunJob).botId === bot.botId);
	assert.ok(queued, `No turn job is queued for bot ${botName}`);
	const job = queued.body as TurnRunJob;
	const scenario = modelScenarioOf(world, modelId);
	if (!scenario.scripted.isScripted) {
		scenario.scripted.reply(defaultScriptedAnswer(scenario.scripted.callCount + 1));
	}
	const run = executorDepsFor(world, scenario, options)
		.then((deps) => executeTurn({ tenantId: job.tenantId, turnId: job.turnId, botId: job.botId }, deps))
		.then((outcome) => {
			scenario.outcomes.push(outcome);
			return outcome;
		});
	scenario.runs.set(job.turnId, run);
	return run;
}

/** Take a bot's queued job and run the real executor on it to the end. */
export const runBotTurn = (world: ChatticusWorld, botName: string, modelId?: string): Promise<TurnExecutionOutcome> =>
	startBotTurn(world, botName, modelId);
