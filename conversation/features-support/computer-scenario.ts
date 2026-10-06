import assert from "node:assert/strict";
import type { ComputerStartJob } from "../src/domain/computer-start.ts";
import { ensureComputer } from "../src/domain/computers.ts";
import type { TurnExecutionOutcome } from "../src/turn/types.ts";
import { type ComputerDisk, FakeComputerHost } from "./fakes/fake-computer-host.ts";
import { runBotTurn, startBotTurn } from "./executor-harness.ts";
import { COMPUTER_START_QUEUE } from "./computer-support.ts";
import { registerWorkerOverHttp } from "./steps/worker-registration.ts";
import { activeTurnOf } from "./turn-grant-support.ts";
import { readTurn, readTurnEvents } from "./steps/model.steps.ts";
import type { ChatticusWorld } from "./world.ts";

/** What a scenario about the computer remembers between its steps. */
export type ComputerScenarioState = {
	readonly hosts: Map<string, FakeComputerHost>;
	readonly disks: Map<string, ComputerDisk>;
	/** How the last execution of a turn ended. */
	lastOutcome: TurnExecutionOutcome | null;
};

const states = new WeakMap<ChatticusWorld, ComputerScenarioState>();

/** The scenario's computer state, created on first use. */
export function computerScenarioOf(world: ChatticusWorld): ComputerScenarioState {
	let state = states.get(world);
	if (state === undefined) {
		state = { hosts: new Map(), disks: new Map(), lastOutcome: null };
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
	const outcome = await runBotTurn(world, botName);
	computerScenarioOf(world).lastOutcome = outcome;
	return outcome;
}

/** Start the executor on the bot's queued run job without waiting for it, keeping how it ends once it does. */
export function startTurn(world: ChatticusWorld, botName: string): Promise<TurnExecutionOutcome> {
	const run = startBotTurn(world, botName);
	return run.then((outcome) => {
		computerScenarioOf(world).lastOutcome = outcome;
		return outcome;
	});
}

/** The turn of the scenario as the HTTP API shows it. */
export async function turnPayloadNow(world: ChatticusWorld): Promise<Record<string, any>> {
	const { tenantId, turnId } = activeTurnOf(world);
	const response = await readTurn(world, tenantId, turnId);
	assert.equal(response.status, 200, response.text);
	return response.json;
}

/** The turn's journal as the HTTP API shows it. */
export async function journalNow(world: ChatticusWorld): Promise<Array<Record<string, any>>> {
	const { tenantId, turnId } = activeTurnOf(world);
	return readTurnEvents(world, tenantId, turnId);
}
