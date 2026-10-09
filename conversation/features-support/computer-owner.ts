import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeOverTurn, type TurnTakeoverOutcome } from "../src/turn/computer-owner.ts";
import { NO_OP_RUN_VISIBILITY, NO_OP_TURN_PROBES, NO_OP_TURN_RUNS } from "../src/turn/in-process-queues.ts";
import type { ExecutorDeps, TurnExecutionOutcome } from "../src/turn/types.ts";
import { STORY_BOT, STORY_TENANT } from "./computer-scenario.ts";
import { executorDepsFor, modelScenarioOf } from "./executor-harness.ts";
import { activeTurnOf } from "./turn-grant-support.ts";
import type { ChatticusWorld } from "./world.ts";

/** A computer owner that a scenario holds between its tool and the recording of the tool's answer. */
export type HeldOwner = {
	readonly reached: Promise<void>;
	readonly release: () => void;
	readonly ended: Promise<TurnTakeoverOutcome>;
};

/** What a scenario about the computer owner remembers between its steps. */
export type ComputerOwnerScenario = {
	readonly workspace: string;
	readonly held: Map<string, HeldOwner>;
	readonly outcomes: Map<string, TurnTakeoverOutcome>;
	readonly turnIds: string[];
	lambdaOutcome: TurnExecutionOutcome | null;
	readonly savedEnvironment: Map<string, string | undefined>;
};

const scenarios = new WeakMap<ChatticusWorld, ComputerOwnerScenario>();

/** The scenario's computer owner state, created on first use with its workspace directory under the scenario's temporary directory. */
export function computerOwnerScenarioOf(world: ChatticusWorld): ComputerOwnerScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
		const workspace = join(world.snapshotTmpdir, "owner-workspace");
		mkdirSync(workspace, { recursive: true });
		scenario = { workspace, held: new Map(), outcomes: new Map(), turnIds: [], lambdaOutcome: null, savedEnvironment: new Map() };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** Put the environment variables the scenario changed back as they were. */
export function restoreOwnerEnvironment(world: ChatticusWorld): void {
	const scenario = scenarios.get(world);
	if (scenario === undefined) return;
	for (const [name, value] of scenario.savedEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	scenario.savedEnvironment.clear();
}

/** The secret value a scenario gives an environment variable of the owner process. */
export const secretValueOf = (name: string): string => `secret-of-${name.toLowerCase()}-9f3a1c`;

/** The executor's dependencies for a computer owner: the scenario's stores and model, with no queue pieces and no time limit. */
export async function computerOwnerDepsFor(world: ChatticusWorld, renewalGate?: Promise<void>): Promise<ExecutorDeps> {
	const shared = await executorDepsFor(world, modelScenarioOf(world), renewalGate === undefined ? {} : { renewalGate });
	const { remainingMilliseconds: _lambdaOnly, ...rest } = shared;
	return { ...rest, turnRuns: NO_OP_TURN_RUNS, turnProbes: NO_OP_TURN_PROBES, runVisibility: NO_OP_RUN_VISIBILITY };
}

/** The job of the scenario's active turn. */
export function activeTurnJob(world: ChatticusWorld): { tenantId: string; turnId: string; botId: string } {
	const bot = world.botsByName?.get(STORY_BOT);
	assert.ok(bot, "The story bot does not exist yet.");
	return { tenantId: STORY_TENANT, turnId: activeTurnOf(world).turnId, botId: bot.botId };
}

/**
 * Start a computer owner on the scenario's active turn.
 *
 * @param world The scenario world.
 * @param label Names the owner in the scenario; its worker id is `computer-owner-<label>`.
 * @param options `hold` stops the owner after its tool ran and before the answer is recorded, until it is released, and
 * keeps its turn lease renewals from running.
 * @param job The turn to take over; the active turn when absent.
 * @param options.workerId The worker id the owner claims under; `computer-owner-<label>` when absent.
 * @returns The owner's ended promise, and the hold when there is one.
 */
export async function startComputerOwner(
	world: ChatticusWorld,
	label: string,
	options: { hold: boolean; job?: { tenantId: string; turnId: string; botId: string }; workerId?: string } = { hold: false },
): Promise<{ ended: Promise<TurnTakeoverOutcome>; held: HeldOwner | null }> {
	const scenario = computerOwnerScenarioOf(world);
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let signalReached: () => void = () => undefined;
	const reached = new Promise<void>((resolve) => {
		signalReached = resolve;
	});
	const deps = await computerOwnerDepsFor(world, options.hold ? gate : undefined);
	const ended = takeOverTurn(options.job ?? activeTurnJob(world), deps, {
		workspaceRoot: scenario.workspace,
		workerId: options.workerId ?? `computer-owner-${label}`,
		...(options.hold
			? {
					beforeRecording: async () => {
						signalReached();
						await gate;
					},
				}
			: {}),
	}).then((outcome) => {
		scenario.outcomes.set(label, outcome);
		return outcome;
	});
	ended.catch(() => undefined);
	if (!options.hold) return { ended, held: null };
	const held: HeldOwner = { reached, release, ended };
	scenario.held.set(label, held);
	return { ended, held };
}
