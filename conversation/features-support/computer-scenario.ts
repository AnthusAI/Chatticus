import assert from "node:assert/strict";
import type { ComputerAction } from "../src/domain/actions.ts";
import { type ComputerStartJob, type ComputerStartOutcome, handleComputerStartJob, type HostStartDriver } from "../src/domain/computer-start.ts";
import type { MessagingStore } from "../src/store/messaging-store.ts";
import { resumeTurnForAction } from "../src/turn/park.ts";
import { FakeHostStartDriver } from "./fakes/fake-host-start-driver.ts";
import { executorDepsFor, modelScenarioOf } from "./executor-harness.ts";
import { createBot } from "../src/domain/bots.ts";
import {
	BROWSER_CAPABILITY,
	ensureComputer,
	MODEL_CAPABILITY,
	recordComputerCapabilityReady,
	setComputerStopped,
	WORKSPACE_CAPABILITY,
} from "../src/domain/computers.ts";
import type { TurnExecutionOutcome } from "../src/turn/types.ts";
import { type ComputerDisk, FakeComputerHost } from "./fakes/fake-computer-host.ts";
import { startBotTurn } from "./executor-harness.ts";
import { actionStoreOf, COMPUTER_START_QUEUE } from "./computer-support.ts";
import { registerWorkerOverHttp } from "./steps/worker-registration.ts";
import { activeTurnOf, ensureMember, memberHeadersFor } from "./turn-grant-support.ts";
import { type RecordedResponse, recordResponse } from "./api.ts";
import { deliverDueProbes, postToBot, RECOVERY_ROUND_SECONDS, runQueuedJobs, turnNow } from "./turn-recovery.ts";
import { openChannelWithNamedBot } from "./steps/message.steps.ts";
import type { ChatticusWorld } from "./world.ts";

/** What a scenario about the computer remembers between its steps. */
export type ComputerScenarioState = {
	readonly hosts: Map<string, FakeComputerHost>;
	readonly disks: Map<string, ComputerDisk>;
	/** How the last execution of a turn ended. */
	lastOutcome: TurnExecutionOutcome | null;
	/** The bot a story scenario's turn belongs to. */
	botName: string | null;
	/** The action a turn was parked on when a story scenario began, to tell the host ran that exact one. */
	pendingActionId: string | null;
	/** Whether the platform's run queue consumer is attached, so a resumed turn continues by itself. */
	runQueueConsumerAttached: boolean;
	/** The hosts that won a claim of an action, in order, when several hosts raced for it. */
	claimWinners: string[];
	/** The start job a queued continuation story is about, kept so the same message can be delivered again. */
	startJob: ComputerStartJob | null;
	/** The driver the starter calls, when a scenario gave it one. */
	driver: FakeHostStartDriver | null;
	/** What the last start job handled ended with, or the error it raised. */
	startOutcome: ComputerStartOutcome | null;
	startError: Error | null;
	/** The computer action each bot's last computer turn ran, to tell which computer served it. */
	lastActionByBot: Map<string, ComputerAction>;
};

const states = new WeakMap<ChatticusWorld, ComputerScenarioState>();

/** The scenario's computer state, created on first use. */
export function computerScenarioOf(world: ChatticusWorld): ComputerScenarioState {
	let state = states.get(world);
	if (state === undefined) {
		state = { hosts: new Map(), disks: new Map(), lastOutcome: null, botName: null, pendingActionId: null, runQueueConsumerAttached: false, claimWinners: [], startJob: null, driver: null, startOutcome: null, startError: null, lastActionByBot: new Map() };
		states.set(world, state);
	}
	return state;
}

/** The tenant of the scenario's bots. */
export function scenarioTenantId(world: ChatticusWorld): string {
	const bot = [...(world.botsByName?.values() ?? [])][0];
	return bot?.tenantId ?? world.lastChannel?.tenantId ?? "anthus";
}

/** The disk of one organization's computer, shared by every host that serves it. */
export function diskOf(world: ChatticusWorld, tenantId: string): ComputerDisk {
	const state = computerScenarioOf(world);
	let disk = state.disks.get(tenantId);
	if (disk === undefined) {
		disk = new Map();
		state.disks.set(tenantId, disk);
	}
	return disk;
}

/**
 * Register a host worker for an organization's computer over HTTP and return the fake process behind it. The worker
 * advertises the computer capability and serves the organization's computer.
 */
export async function registerHost(
	world: ChatticusWorld,
	tenantId: string,
	workerId: string,
	costClass: string,
): Promise<FakeComputerHost> {
	const computer = await ensureComputer(tenantId, { store: world.messagingStore(), ids: world.ids });
	const token = await registerWorkerOverHttp(world, {
		tenantId,
		workerId,
		costClass,
		capabilities: ["computer", "browser"],
		computerId: computer.computerId,
	});
	const host = new FakeComputerHost(world, tenantId, workerId, token, diskOf(world, tenantId));
	computerScenarioOf(world).hosts.set(workerId, host);
	return host;
}

/** The registered fake host with this worker id. */
export function hostNamed(world: ChatticusWorld, workerId: string): FakeComputerHost {
	const host = computerScenarioOf(world).hosts.get(workerId);
	assert.ok(host, `No host worker ${JSON.stringify(workerId)} is registered in this scenario.`);
	return host;
}

/** Every start job queued for the computer, oldest first. */
export function queuedStartJobs(world: ChatticusWorld): ComputerStartJob[] {
	return world.queues.pending(COMPUTER_START_QUEUE).map((queued) => queued.body as ComputerStartJob);
}

/**
 * Run the real executor on the bot's queued run job and keep how it ended.
 *
 * @returns The outcome.
 */
export async function workTurn(world: ChatticusWorld, botName: string): Promise<TurnExecutionOutcome> {
	const outcome = await startBotTurn(world, botName, undefined, { turnId: world.lastTurnId ?? undefined });
	computerScenarioOf(world).lastOutcome = outcome;
	return outcome;
}

/** GET `path` as the member who owns the scenario's bots, who is a member of the organization the turn belongs to. */
async function getAsMember(world: ChatticusWorld, tenantId: string, path: string): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const userId = [...world.botCreatorUserIds.values()][0] ?? STORY_USER;
	return recordResponse(await world.api.get(path, { headers: await memberHeadersFor(world, tenantId, userId) }));
}

/** The turn of the scenario as the HTTP API shows it. */
export async function turnPayloadNow(world: ChatticusWorld): Promise<Record<string, any>> {
	const { tenantId, turnId } = activeTurnOf(world);
	const response = await getAsMember(world, tenantId, `/orgs/${tenantId}/turns/${turnId}`);
	assert.equal(response.status, 200, response.text);
	return response.json;
}

/** The turn's journal as the HTTP API shows it. */
export async function journalNow(world: ChatticusWorld): Promise<Array<Record<string, any>>> {
	const { tenantId, turnId } = activeTurnOf(world);
	const response = await getAsMember(world, tenantId, `/orgs/${tenantId}/turns/${turnId}/events`);
	assert.equal(response.status, 200, response.text);
	return response.json.events;
}

/** The host worker the household computer comes up with. */
export const HOUSEHOLD_HOST_WORKER_ID = "household-host";

/**
 * The household computer becomes ready: it is running, every capability gate is clear, and its host worker is registered.
 * The host finds its work as a booting host does, by claiming actions one after another and posting each result.
 *
 * @returns The actions the host ran, in order.
 */
export async function bringComputerUp(world: ChatticusWorld, tenantId: string): Promise<Array<Record<string, any>>> {
	const store = { store: world.messagingStore(), ids: world.ids };
	await setComputerStopped(tenantId, false, store);
	for (const capability of [MODEL_CAPABILITY, WORKSPACE_CAPABILITY, BROWSER_CAPABILITY]) {
		await recordComputerCapabilityReady(tenantId, capability, store);
	}
	const state = computerScenarioOf(world);
	const host = state.hosts.get(HOUSEHOLD_HOST_WORKER_ID) ?? (await registerHost(world, tenantId, HOUSEHOLD_HOST_WORKER_ID, "local"));
	await host.heartbeat();
	const ran: Array<Record<string, any>> = [];
	for (let action = await host.runNextAction(); action !== null; action = await host.runNextAction()) {
		state.claimWinners.push(host.workerId);
		ran.push(action);
	}
	return ran;
}

/** The organization, member and bot of the story scenarios that tell what happens to one turn on the computer. */
export const STORY_TENANT = "anthus";
export const STORY_USER = "ryan";
export const STORY_BOT = "Researcher";

/** Open a channel with the story's bot (creating the bot and its member when the scenario has none) and post the message. */
export async function startStoryTurn(world: ChatticusWorld, message: string): Promise<string> {
	await ensureMember(world, STORY_TENANT, STORY_USER);
	if (world.botsByName?.get(STORY_BOT) === undefined) {
		const bot = await createBot(STORY_TENANT, STORY_BOT, { creatorUserId: STORY_USER }, { store: world.messagingStore(), ids: world.ids });
		world.botsById?.set(bot.botId, bot);
		world.botsByName?.set(STORY_BOT, bot);
	}
	await openChannelWithNamedBot(world, STORY_TENANT, STORY_USER, STORY_BOT);
	world.lastTurnId = await postToBot(world, STORY_BOT, message);
	computerScenarioOf(world).botName = STORY_BOT;
	return world.lastTurnId;
}

/** The most rounds a story turn is given to settle. */
export const MAXIMUM_HANDOFF_ROUNDS = 6;

/**
 * Let the platform and the hosts recover a story turn: every round moves the clock past one lease, delivers the probes
 * that came due, consumes the run jobs, and lets the registered hosts race for the next action, the winner running it
 * and posting its result. Stops when the turn is no longer active.
 *
 * @param world The scenario world.
 * @param hostIds The hosts that race for actions; they are registered on first use.
 */
export async function recoverHandoff(world: ChatticusWorld, hostIds: readonly string[]): Promise<void> {
	world.faultPlan.clear();
	const state = computerScenarioOf(world);
	for (const workerId of hostIds) {
		if (!state.hosts.has(workerId)) await registerHost(world, STORY_TENANT, workerId, "local");
	}
	for (let round = 0; round < MAXIMUM_HANDOFF_ROUNDS; round += 1) {
		if ((await turnNow(world)).status !== "active") return;
		world.clock.advanceSeconds(RECOVERY_ROUND_SECONDS);
		await deliverDueProbes(world);
		await runQueuedJobs(world);
		const claims = await Promise.all(hostIds.map(async (workerId) => ({ host: hostNamed(world, workerId), action: await hostNamed(world, workerId).claim() })));
		const winners = claims.filter((claim) => claim.action !== null);
		assert.ok(winners.length <= 1, `Hosts ${winners.map((winner) => winner.host.workerId)} all control the computer`);
		for (const winner of winners) {
			state.claimWinners.push(winner.host.workerId);
			const posted = await winner.host.postResult(winner.action!.action_id, winner.host.execute(winner.action!));
			assert.equal(posted.status, 200, posted.text);
		}
	}
	assert.notEqual((await turnNow(world)).status, "active", "The turn was still active after every round of recovery");
}

/** The driver that starts the household host by booting the fake host, which then finds and runs its work. */
export function bootingHostStartDriver(world: ChatticusWorld): FakeHostStartDriver {
	return new FakeHostStartDriver(async (claim) => {
		await bringComputerUp(world, claim.tenantId);
	});
}

/**
 * Deliver one start job to the starter, as its queue consumer does: take the job off the queue first, hand it to the
 * handler, and put it back when the handler fails. The starter shares the scenario's stores, or those of `store` when a
 * second process is meant.
 *
 * @returns How the handler ended; the error is kept on the scenario state instead of raised.
 */
export async function deliverStartJob(
	world: ChatticusWorld,
	job: ComputerStartJob,
	driver: HostStartDriver,
	store: MessagingStore = world.messagingStore(),
): Promise<ComputerStartOutcome | null> {
	const state = computerScenarioOf(world);
	world.queues.take(COMPUTER_START_QUEUE, (body) => (body as ComputerStartJob).jobId === job.jobId);
	const scenario = modelScenarioOf(world);
	const parkDeps = (await executorDepsFor(world, scenario));
	state.startError = null;
	try {
		state.startOutcome = await handleComputerStartJob(
			{
				store,
				clock: world.clock,
				ids: world.ids,
				heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds,
				turns: parkDeps.turns,
				spend: { store, rollups: world.store, environment: world.budgetEnvironment, clock: world.clock },
				actions: actionStoreOf(world),
				driver,
				resumeTurn: (tenantId, turnId, actionId) =>
					resumeTurnForAction(
						{
							turns: parkDeps.turns,
							messaging: store,
							turnRuns: parkDeps.turnRuns,
							turnProbes: parkDeps.turnProbes,
							computer: parkDeps.computer,
							faults: parkDeps.faults,
						},
						tenantId,
						turnId,
						actionId,
					).then(() => undefined),
			},
			job,
		);
	} catch (error) {
		world.queues.send(COMPUTER_START_QUEUE, job);
		state.startError = error as Error;
		state.startOutcome = null;
	}
	return state.startOutcome;
}
