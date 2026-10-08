/**
 * The computer owner: a process inside the organization's computer takes over a turn and runs it with the executor's own
 * core, with Pi's tools executing on the computer's disk, and then lets go of the session so a Lambda owner can continue it.
 *
 * Nothing here is a second executor. `takeOverTurn` prepares the turn (resuming it when it is parked) and calls
 * `executeTurn`, which claims the turn with a new attempt, opens the session under a new storage fence, runs the model
 * loop with the same gate, mailbox, journal and finalizer a Lambda owner has, and ends the turn as done, failed or parked.
 * The only differences are the dependencies it is given: local computer tools, no-op queue pieces and no time limit.
 *
 * How it is triggered in production: the container's entry point calls `takeOverTurn` with the tenant, turn and bot named
 * by the job that started the computer (the start job the control plane publishes when a turn parks on a computer
 * action), once the workspace is hydrated and the owner holds its scoped credentials. Nothing in the control plane calls
 * it yet; the remote-tool path (park, host claim, result) is unchanged and is what a Lambda owner still does.
 */

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { localComputerToolsExtension } from "../pi/local-computer-tools.ts";
import { executeTurn } from "./executor.ts";
import { resumeTurnForAction } from "./park.ts";
import type { ComputerToolCall } from "../pi/computer-tools.ts";
import type { ExecutorDeps, TurnExecutionJob, TurnExecutionOutcome } from "./types.ts";

/** Where and as whom a computer owner runs. */
export type ComputerOwnerOptions = {
	/** The directory of the computer's workspace on this machine. */
	readonly workspaceRoot: string;
	/** The path the model sees the workspace at; `/workspace` unless a test roots it elsewhere. */
	readonly workspacePath?: string;
	/** Identifies this owner on the computer actions it claims and on the turn it claims. */
	readonly workerId: string;
	/** The program the model's commands are started through (see `LocalComputerToolsOptions.shellPath`); the default shell when absent. */
	readonly shellPath?: string;
	/** Called after a local tool ran and before its answer is recorded; a scenario holds the owner here to stand for a crash. */
	readonly beforeRecording?: (call: ComputerToolCall) => Promise<void>;
};

/**
 * How a takeover ended: one of the executor's outcomes, or one of two the executor never sees.
 *
 * - `not_found`: no such turn of that bot; nothing was written.
 * - `already_finished`: the turn is completed or failed; nothing was written.
 * - the executor's outcomes: `done`, `failed`, `parked` (a tool that cannot run locally, such as the browser, parked the
 *   turn), `yielded`, `reconciling`, and `lost` (a live owner holds the turn, another owner won the claim, or this owner
 *   lost the turn while it ran; nothing was written for it).
 */
export type TurnTakeoverOutcome = TurnExecutionOutcome | "not_found" | "already_finished";

/**
 * Take over one turn and run it to its end with the computer's own tools.
 *
 * A turn parked on a computer action is resumed first, which clears its waiting without publishing a run job to this
 * owner's queue pieces; then the turn is claimed. Only one of several owners that race for the turn wins the claim; the
 * others end `lost` and change nothing. A turn whose owner vanished is taken once that owner's lease has run out. Errors
 * of the stores propagate, as they do from `executeTurn`, and leave the turn for the queue or the probe to retry.
 *
 * @param job The tenant, turn and bot.
 * @param deps The executor's dependencies. Their run queue, probe queue and run visibility should be the no-op ones of
 * `in-process-queues.ts` for an owner that is not an SQS consumer; `computerTools` and `env` are replaced here.
 * @param options Workspace and identity of the owner.
 * @returns How the takeover ended.
 */
export async function takeOverTurn(job: TurnExecutionJob, deps: ExecutorDeps, options: ComputerOwnerOptions): Promise<TurnTakeoverOutcome> {
	const turn = await deps.turns.store.getTurn(job.tenantId, job.turnId);
	if (turn === null || turn.botId !== job.botId) return "not_found";
	if (turn.status !== "active") return "already_finished";
	if (turn.waitingFor !== null) {
		await resumeTurnForAction(
			{ turns: deps.turns, messaging: deps.messaging, turnRuns: deps.turnRuns, turnProbes: deps.turnProbes, computer: deps.computer, faults: deps.faults },
			job.tenantId,
			job.turnId,
			turn.pendingComputerTool?.actionId ?? `resume-${turn.waitingSince?.getTime() ?? 0}`,
		);
	}
	return executeTurn(job, {
		...deps,
		workerLabel: options.workerId,
		env: () => new NodeExecutionEnv({ cwd: options.workspaceRoot, ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }) }),
		computerTools: (handoff) =>
			localComputerToolsExtension(handoff, {
				workspaceRoot: options.workspaceRoot,
				workspacePath: options.workspacePath,
				workerId: options.workerId,
				shellPath: options.shellPath,
				turn,
				actions: deps.computer.actions,
				messaging: deps.messaging,
				clock: deps.turns.clock,
				ids: deps.turns.ids,
				beforeRecording: options.beforeRecording,
			}),
	});
}
