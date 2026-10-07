/**
 * Parking a turn on a computer action, and resuming it when the computer has answered.
 *
 * The owner of a turn that calls a computer tool records a durable action keyed by the Pi tool call id, parks the turn
 * (the turn stays `active` with `waiting_for` set and no owner), publishes a start job when no live host serves the
 * computer, and closes its harness without aborting. The host claims the action, runs it and posts a result; the result
 * clears the waiting and publishes an ordinary run job, and the next owner (a higher fence) reopens the session, where the
 * `pi.tool` task resumes at its `execute`, finds the result by call id and does not run the tool twice.
 *
 * Replaces python/src/chatticus/control_plane.py `prepare_computer_tool`, `commit_pending_computer_tool`,
 * `enqueue_computer_continuation`, `relinquish_computerless_ownership`, `resume_waiting_turn` and
 * `request_computer_host_start`'s caller. There is no in-memory escalation dictionary and no EventBridge rule.
 */

import {
	type ComputerAction,
	type ComputerActionStore,
	expireLostComputerActions,
	requestComputerAction,
	type ActionDependencies,
} from "../domain/actions.ts";
import { BROWSER_ACTION_KINDS } from "@chatticus/host-protocol";
import type { BudgetRollupReader } from "../domain/organization-spend.ts";
import { computerWorkPauseReason } from "../domain/organization-spend.ts";
import { BROWSER_UNAVAILABLE_TEXT, computerIsStopped, ensureComputer } from "../domain/computers.ts";
import type { ComputerStartQueue } from "../domain/computer-start.ts";
import { clearWaiting, getTurn, releaseForWaiting, TURN_DEADLINE_SECONDS, type Turn, type TurnDependencies } from "../domain/turns.ts";
import type { TurnProbeQueue, TurnRunQueue } from "../domain/turn-admission.ts";
import { assignTurn, createTurnJob } from "../domain/workers.ts";
import { ComputerNotReadyError, TurnNotWaitingError, TurnTerminalError } from "../http/errors.ts";
import type { ComputerToolCall } from "../pi/computer-tools.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { FaultPlan } from "./fault-plan.ts";
import { armProbe, requestLogicalEnqueue, runJobFor } from "./probes.ts";

/** What the computer handoff needs beyond the turn stores. */
export type ComputerHandoffDependencies = {
	readonly actions: ComputerActionStore;
	readonly computerStarts: ComputerStartQueue;
	/** The rollup rows the spend ceiling pause reads. */
	readonly rollups: BudgetRollupReader;
	/** The budget environment the rollup rows belong to. */
	readonly environment: string;
	/** Seconds without a heartbeat after which a host is not live. */
	readonly heartbeatTimeoutSeconds: number;
};

/** Everything parking and resuming read and write. */
export type ParkDependencies = {
	readonly turns: TurnDependencies;
	readonly messaging: MessagingStore;
	readonly turnRuns: TurnRunQueue;
	readonly turnProbes: TurnProbeQueue;
	readonly computer: ComputerHandoffDependencies;
	readonly faults?: FaultPlan;
};

/** The identifier of the run a resume requests for the action that ended a turn's waiting. */
export const resumeEnqueueId = (turnId: string, actionId: string): string => `${turnId}#resume-${actionId}`;

/**
 * The action functions' dependencies over a handoff's stores.
 *
 * @param deps The handoff dependencies.
 * @returns Action store, clock and identifiers.
 */
export const actionDependenciesOf = (deps: ParkDependencies): ActionDependencies => ({
	actions: deps.computer.actions,
	clock: deps.turns.clock,
	ids: deps.turns.ids,
});

/**
 * Why new computer work must not start for an organization (the monthly spend ceiling), or null. Called before a computer
 * action is created.
 *
 * @param deps The handoff dependencies.
 * @param tenantId Organization.
 * @returns The reason a member can read, or null when computer work may start.
 */
export async function computerWorkRefusal(deps: ParkDependencies, tenantId: string): Promise<string | null> {
	return computerWorkPauseReason(tenantId, {
		store: deps.messaging,
		rollups: deps.computer.rollups,
		environment: deps.computer.environment,
		clock: deps.turns.clock,
	});
}

/**
 * The answer of a browser tool call when the computer's image has no browser, so the call parks nothing and starts no
 * host. Any other tool, and a computer that has not reported the browser unavailable, answers null.
 *
 * @param deps The handoff dependencies.
 * @param tenantId Organization.
 * @param call The tool call.
 * @returns The text the call answers with, or null when the tool may run.
 */
export async function computerToolUnavailableText(deps: ParkDependencies, tenantId: string, call: ComputerToolCall): Promise<string | null> {
	if (!BROWSER_ACTION_KINDS.has(call.toolName)) return null;
	return (await deps.messaging.getComputer(tenantId))?.browserUnavailable === true ? BROWSER_UNAVAILABLE_TEXT : null;
}

/**
 * Make sure a live host will serve the turn's computer: when none is registered and healthy, publish a start job.
 * The job is built and the host chosen by the same routing the worker registry uses (`createTurnJob`, `assignTurn`), so a
 * computer policy of `aws_only` or `local_only` reaches the starter in the job.
 *
 * @param deps The handoff dependencies.
 * @param turn The parked turn.
 * @returns Whether a start job was published.
 */
export async function ensureHostForParkedTurn(deps: ParkDependencies, turn: Turn): Promise<boolean> {
	if (turn.promptAuthorId === null) {
		throw new Error(`Turn ${JSON.stringify(turn.turnId)} has no prompt author to start a computer for.`);
	}
	const job = await createTurnJob(
		{ tenantId: turn.tenantId, requiredCapabilities: new Set(["computer"]), botId: turn.botId, userId: turn.promptAuthorId },
		{ store: deps.messaging, ids: deps.turns.ids },
	);
	const host = await assignTurn(job, {
		store: deps.messaging,
		clock: deps.turns.clock,
		heartbeatTimeoutSeconds: deps.computer.heartbeatTimeoutSeconds,
	});
	if (host !== null) return false;
	deps.faults?.maybeCrash("computer_start", "before");
	await deps.computer.computerStarts.enqueue({
		jobId: job.jobId,
		tenantId: job.tenantId,
		turnId: turn.turnId,
		botId: turn.botId,
		userId: turn.promptAuthorId,
		computerId: job.computerId ?? (await ensureComputer(turn.tenantId, { store: deps.messaging, ids: deps.turns.ids })).computerId,
		computerPolicy: job.computerPolicy,
		requiredCapabilities: [...job.requiredCapabilities],
	});
	deps.faults?.maybeCrash("computer_start", "after");
	return true;
}

/**
 * End the waiting of a turn and publish the run that resumes it. Safe to repeat: only the call that clears the waiting
 * publishes, and the run is deduplicated by the action that ended the waiting.
 *
 * @param deps The handoff dependencies.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param actionId The action whose answer resumes the turn.
 * @returns Whether this call resumed the turn.
 */
export async function resumeTurnForAction(
	deps: ParkDependencies,
	tenantId: string,
	turnId: string,
	actionId: string,
): Promise<boolean> {
	const cleared = await clearWaiting(deps.turns, tenantId, turnId);
	if (cleared === null) return false;
	await requestLogicalEnqueue(
		{ recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
		runJobFor(cleared),
		resumeEnqueueId(turnId, actionId),
	);
	await armProbe(deps.turnProbes, cleared, TURN_DEADLINE_SECONDS);
	return true;
}

/**
 * Park a turn on the computer action of one tool call: record the action, drop the claim so the turn waits on its gate
 * with `turn.waiting`, and make sure a host will come. The caller closes the harness afterwards, without aborting.
 *
 * No probe is armed here: the probe armed at the claim is the one that watches the turn while it waits, and it re-arms
 * itself until the waiting limit.
 *
 * Every step is safe to repeat after a crash: a second owner that reaches the same call finds the same action.
 *
 * @param deps The handoff dependencies.
 * @param turn The turn as the owner claimed it.
 * @param attemptId The owner's attempt.
 * @param call The tool call, with the Pi call id the action is keyed by.
 * @returns The action the turn is parked on.
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function parkOnComputerAction(
	deps: ParkDependencies,
	turn: Turn,
	attemptId: string,
	call: ComputerToolCall,
): Promise<ComputerAction> {
	const computer = await ensureComputer(turn.tenantId, { store: deps.messaging, ids: deps.turns.ids });
	deps.faults?.maybeCrash("computer_action", "before");
	const action = await requestComputerAction(actionDependenciesOf(deps), {
		tenantId: turn.tenantId,
		computerId: computer.computerId,
		turnId: turn.turnId,
		channelId: turn.channelId,
		botId: turn.botId,
		userId: turn.promptAuthorId,
		callId: call.callId,
		toolName: call.toolName,
		arguments: call.arguments,
	});
	deps.faults?.maybeCrash("computer_action", "after");
	deps.faults?.maybeCrash("computer_park", "before");
	await releaseForWaiting(deps.turns, turn.tenantId, turn.turnId, attemptId, action.gate, {
		actionId: action.actionId,
		toolName: action.toolName,
		arguments: { ...action.arguments },
	});
	deps.faults?.maybeCrash("computer_park", "after");
	await ensureHostForParkedTurn(deps, turn);
	const current = await deps.computer.actions.get(turn.tenantId, action.actionId);
	if (current?.status === "done") {
		await resumeTurnForAction(deps, turn.tenantId, turn.turnId, action.actionId);
	}
	return current ?? action;
}

/**
 * Resume a waiting turn on request (the web or an operator, once the computer is running again). The turn goes back to
 * the run queue; its next owner finds the action's answer, or parks again if the host has not answered yet.
 *
 * Ported from python/src/chatticus/control_plane.py `resume_waiting_turn`.
 *
 * @param deps The handoff dependencies.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @returns The turn that was resumed.
 * @throws TurnNotFoundError If the turn is unknown.
 * @throws TurnTerminalError If the turn is no longer active.
 * @throws TurnNotWaitingError If the turn is not blocked on a gate.
 * @throws ComputerNotReadyError If the organization computer is stopped.
 */
export async function resumeWaitingTurn(deps: ParkDependencies, tenantId: string, turnId: string): Promise<Turn> {
	const turn = await getTurn(deps.turns, tenantId, turnId);
	if (turn.status !== "active") {
		throw new TurnTerminalError(`Turn ${JSON.stringify(turnId)} is not active.`);
	}
	if (turn.waitingFor === null) {
		throw new TurnNotWaitingError(`Turn ${JSON.stringify(turnId)} is not waiting on a readiness gate.`);
	}
	if (await computerIsStopped(tenantId, { store: deps.messaging })) {
		throw new ComputerNotReadyError(
			`Organization computer for tenant ${JSON.stringify(tenantId)} is still stopped; turn ${JSON.stringify(turnId)} remains waiting on ${JSON.stringify(turn.waitingFor)}.`,
		);
	}
	await resumeTurnForAction(deps, tenantId, turnId, turn.pendingComputerTool?.actionId ?? `resume-${turn.waitingSince?.getTime() ?? 0}`);
	return turn;
}

/**
 * What a probe does for a turn parked on a computer action. An action whose host was lost is settled (run again when that
 * is harmless, answered as interrupted when it is not); a turn whose action is answered resumes, which covers a result
 * recorded just before a crash that never resumed the turn; a turn whose action nobody has claimed asks for a host start
 * again, which the starter shares with the start already under way while its lease lasts.
 *
 * @param deps The handoff dependencies.
 * @param turn The waiting turn as the probe read it.
 * @returns Whether the turn was resumed.
 */
export async function settleParkedTurn(deps: ParkDependencies, turn: Turn): Promise<boolean> {
	const pending = turn.pendingComputerTool;
	if (pending === null) return false;
	let resumed = false;
	for (const changed of await expireLostComputerActions(actionDependenciesOf(deps), turn.tenantId)) {
		if (changed.status === "done" && (await resumeTurnForAction(deps, changed.tenantId, changed.turnId, changed.actionId))) {
			resumed = resumed || changed.turnId === turn.turnId;
		}
	}
	if (resumed) return true;
	const action = await deps.computer.actions.get(turn.tenantId, pending.actionId);
	if (action?.status === "done") {
		return resumeTurnForAction(deps, turn.tenantId, turn.turnId, action.actionId);
	}
	if (action?.status === "requested") {
		await ensureHostForParkedTurn(deps, turn);
	}
	return false;
}
