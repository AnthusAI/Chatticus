import {
	ATTEMPT_LEASE_SECONDS,
	getTurn,
	relinquishTurn,
	releaseForWaiting,
	TURN_DEADLINE_SECONDS,
	type TurnDependencies,
} from "../domain/turns.ts";
import type { TurnProbeQueue, TurnRunQueue } from "../domain/turn-admission.ts";
import type { FaultPlan } from "./fault-plan.ts";
import { armProbe, requestLogicalEnqueue, runJobFor, yieldEnqueueId } from "./probes.ts";

/** What handing a turn on needs. */
export type HandoffDependencies = {
	readonly turns: TurnDependencies;
	readonly turnRuns: TurnRunQueue;
	readonly turnProbes: TurnProbeQueue;
	readonly faults?: FaultPlan;
};

/** The remaining function time under which an owner hands its turn on instead of risking the limit. */
export const DEFAULT_YIELD_BELOW_MILLISECONDS = 30_000;

/**
 * Give a running turn to the next owner because this function is close to its time limit: append `attempt.relinquished`,
 * drop the claim and request one more run, which resumes the same Pi session. The caller closes its harness without
 * aborting, so the model call in flight is simply resumed by the next owner.
 *
 * @param deps Stores and queues.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param attemptId The attempt that hands the turn on.
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function yieldAttempt(
	deps: HandoffDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
): Promise<void> {
	const turn = await getTurn(deps.turns, tenantId, turnId);
	await relinquishTurn(deps.turns, tenantId, turnId, attemptId);
	await requestLogicalEnqueue(
		{ recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
		runJobFor(turn),
		yieldEnqueueId(turnId, turn.attempt),
	);
	await armProbe(deps.turnProbes, turn, TURN_DEADLINE_SECONDS);
}

/**
 * Park a running turn on a gate the owner cannot wait out (the computer is not ready): the turn stays active with the
 * gate named, the claim is dropped, and a probe is armed so a turn that is never un-parked fails once it has waited past
 * the limit.
 *
 * @param deps Stores and queues.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param attemptId The attempt that parks the turn.
 * @param gate The gate the turn waits on.
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function parkAttempt(
	deps: Pick<HandoffDependencies, "turns" | "turnProbes">,
	tenantId: string,
	turnId: string,
	attemptId: string,
	gate: string,
): Promise<void> {
	await releaseForWaiting(deps.turns, tenantId, turnId, attemptId, gate);
	await armProbe(deps.turnProbes, await getTurn(deps.turns, tenantId, turnId), ATTEMPT_LEASE_SECONDS);
}
