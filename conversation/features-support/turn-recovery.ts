import assert from "node:assert/strict";
import { ConditionalCheckFailedException, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { TurnRunJob } from "../src/domain/turn-admission.ts";
import { getTurn, type Turn } from "../src/domain/turns.ts";
import { PiSubmissionInspector } from "../src/pi/submission-inspector.ts";
import { turnItemPartitionKey } from "../src/store/turn-events.ts";
import { consumeRunJob } from "../src/turn/executor.ts";
import { handleProbe, type ProbeDependencies } from "../src/turn/probes.ts";
import type { TurnExecutionOutcome } from "../src/turn/types.ts";
import { computerHandoffDependenciesFor } from "./computer-support.ts";
import { executorDepsFor, type ExecutorOptions, modelScenarioOf } from "./executor-harness.ts";
import { memberGet } from "./org-user-client.ts";
import { ensurePiStorage } from "./pi-storage.ts";
import { recordResponse } from "./api.ts";
import { post } from "./steps/message.steps.ts";
import { probeQueueOf, runQueueOf, TURN_PROBE_QUEUE, TURN_RUN_QUEUE } from "./turn-queues.ts";
import type { TurnProbeMessage } from "../src/domain/turn-admission.ts";
import type { ChatticusWorld } from "./world.ts";

/** Seconds the harness moves the fake clock between rounds of recovery: just past one attempt lease. */
export const RECOVERY_ROUND_SECONDS = 61;

/** The most rounds a turn is given to reach a terminal state. */
export const MAXIMUM_RECOVERY_ROUNDS = 8;

/** The turn the scenario's last post started or joined. */
export function currentTurnId(world: ChatticusWorld): string {
	assert.ok(world.lastTurnId, "The last post started no turn");
	return world.lastTurnId;
}

/** The open channel. */
export function openChannel(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

/** Post a message from the channel's human to a bot through the HTTP front door and return the turn it started. */
export async function postToBot(world: ChatticusWorld, botName: string, body: string): Promise<string> {
	const channel = openChannel(world);
	const bot = world.botsByName?.get(botName);
	assert.ok(bot, `Bot ${botName} not found`);
	const described = await recordResponse(await memberGet(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}`));
	assert.equal(described.status, 200, described.text);
	const response = await post(world, { authorKind: "human", authorId: described.json.user_id, body, addressedToBotId: bot.botId });
	assert.equal(response.status, 200, response.text);
	assert.ok(response.json.turn_id, "The post started no turn");
	return response.json.turn_id as string;
}

/** The turn as the control record holds it now. */
export async function turnNow(world: ChatticusWorld, turnId: string = currentTurnId(world)): Promise<Turn> {
	return getTurn(world.turnDependencies(), openChannel(world).tenantId, turnId);
}

/** The run jobs waiting on the queue for one turn. */
export function queuedRunsFor(world: ChatticusWorld, turnId: string): TurnRunJob[] {
	return world.queues
		.pending(TURN_RUN_QUEUE)
		.map((queued) => queued.body as TurnRunJob)
		.filter((job) => job.turnId === turnId);
}

/** The probes waiting on the delay queue for one turn, held back or due. */
export function queuedProbesFor(world: ChatticusWorld, turnId: string): TurnProbeMessage[] {
	return world.queues
		.pending(TURN_PROBE_QUEUE)
		.map((queued) => queued.body as TurnProbeMessage)
		.filter((probe) => probe.turnId === turnId);
}

/** The delays, in seconds, of the probes waiting for one turn. */
export function queuedProbeDelaysFor(world: ChatticusWorld, turnId: string): number[] {
	return world.queues
		.pending(TURN_PROBE_QUEUE)
		.filter((queued) => (queued.body as TurnProbeMessage).turnId === turnId)
		.map((queued) => queued.delaySeconds ?? 0);
}

/** The probe handler's dependencies over the scenario's tables, queues and Pi storage. */
export async function probeDependenciesFor(world: ChatticusWorld): Promise<ProbeDependencies> {
	const piStorage = await ensurePiStorage(world);
	return {
		turns: world.turnDependencies(),
		turnRuns: runQueueOf(world),
		turnProbes: probeQueueOf(world),
		messaging: world.messagingStore(),
		computer: computerHandoffDependenciesFor(world),
		submissions: new PiSubmissionInspector({
			client: world.messagingTable.client,
			s3: piStorage.s3,
			tableName: piStorage.tableName,
			bucket: piStorage.bucket,
		}),
		faults: world.faultPlan,
	};
}

/**
 * Deliver every probe whose delay has run out on the fake clock to the probe handler, as the delay queue would. A probe
 * whose handler fails is delivered again, like an SQS message that was not deleted, and the failure is raised.
 */
export async function deliverDueProbes(world: ChatticusWorld): Promise<void> {
	const deps = await probeDependenciesFor(world);
	for (let due = world.queues.takeDue(TURN_PROBE_QUEUE); due !== null; due = world.queues.takeDue(TURN_PROBE_QUEUE)) {
		try {
			await handleProbe(deps, due.body as TurnProbeMessage);
		} catch (error) {
			world.queues.send(TURN_PROBE_QUEUE, due.body);
			throw error;
		}
	}
}

/**
 * Consume every run job on the queue the way the TurnExecutor Lambda does. A job whose execution fails before its
 * acknowledgement stays on the queue and is delivered again, and the failure is raised.
 *
 * @returns How each consumed job ended, in order.
 */
export async function runQueuedJobs(world: ChatticusWorld, options: ExecutorOptions = {}): Promise<TurnExecutionOutcome[]> {
	const scenario = modelScenarioOf(world);
	const outcomes: TurnExecutionOutcome[] = [];
	for (let queued = world.queues.take(TURN_RUN_QUEUE, () => true); queued !== null; queued = world.queues.take(TURN_RUN_QUEUE, () => true)) {
		const job = queued.body as TurnRunJob;
		let acknowledged = false;
		try {
			const deps = await executorDepsFor(world, scenario, options);
			const outcome = await consumeRunJob({ tenantId: job.tenantId, turnId: job.turnId, botId: job.botId }, deps, async () => {
				acknowledged = true;
			});
			scenario.outcomes.push(outcome);
			outcomes.push(outcome);
		} catch (error) {
			if (!acknowledged) world.queues.send(TURN_RUN_QUEUE, job);
			throw error;
		}
	}
	return outcomes;
}

/**
 * Let time pass until the turn is no longer active: each round moves the fake clock past one lease, delivers the probes
 * that came due and consumes the run jobs they queued.
 *
 * @returns The turn when it left the active state.
 */
export async function passTimeUntilSettled(world: ChatticusWorld, turnId: string, options: ExecutorOptions = {}): Promise<Turn> {
	for (let round = 0; round < MAXIMUM_RECOVERY_ROUNDS; round += 1) {
		const turn = await turnNow(world, turnId);
		if (turn.status !== "active") break;
		world.clock.advanceSeconds(RECOVERY_ROUND_SECONDS);
		await deliverDueProbes(world);
		await runQueuedJobs(world, options);
	}
	const settled = await turnNow(world, turnId);
	assert.notEqual(settled.status, "active", "The turn was still active after every round of recovery");
	return settled;
}

/**
 * Put a turn's recovery counter at `attempts`, the state a turn is in once recovery has been tried that many times. The
 * counter is the only thing set; every other change comes from the production code under test.
 */
export async function setRecoveryAttempts(world: ChatticusWorld, tenantId: string, turnId: string, attempts: number): Promise<void> {
	try {
		await world.messagingTable.client.send(
			new UpdateItemCommand({
				TableName: world.messagingTable.tableName,
				Key: { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: "meta" } },
				UpdateExpression: "SET recovery_attempts = :attempts",
				ConditionExpression: "attribute_exists(pk)",
				ExpressionAttributeValues: { ":attempts": { N: String(attempts) } },
			}),
		);
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) assert.fail(`Turn ${turnId} does not exist`);
		throw error;
	}
}

/** The workers that currently hold an unexpired lease on an active turn; at most one is allowed. */
export function authoritativeWorkers(turn: Turn, now: Date): string[] {
	if (turn.status !== "active") return [];
	const leased = turn.leaseExpiresAt !== null && turn.leaseExpiresAt.getTime() > now.getTime();
	return leased && turn.claimedBy !== null ? [turn.claimedBy] : [];
}

/** Wait until a condition that depends on the system's own state holds; the wait is bounded only to fail a stuck run. */
export async function eventuallyTrue(condition: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!(await condition())) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Let a worker the scenario froze finish and check that it learned it lost the turn. */
export async function retireFrozenWorker(world: ChatticusWorld): Promise<void> {
	const scenario = modelScenarioOf(world);
	scenario.hold?.release();
	scenario.openRenewals?.();
	if (scenario.firstAttempt !== undefined) {
		assert.equal(await scenario.firstAttempt, "lost");
		scenario.firstAttempt = undefined;
	}
}
