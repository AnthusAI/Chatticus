import {
	ATTEMPT_LEASE_SECONDS,
	failStaleTurn,
	recoverExpiredTurn,
	TURN_DEADLINE_SECONDS,
	type Turn,
	type TurnDependencies,
} from "../domain/turns.ts";
import type { TurnProbeMessage, TurnProbeQueue, TurnRunJob, TurnRunQueue } from "../domain/turn-admission.ts";
import type { FaultPlan } from "./fault-plan.ts";

/** The longest an SQS delay queue holds a message back. */
export const MAXIMUM_PROBE_DELAY_SECONDS = 900;

/** How long a turn may wait on a gate (the computer) before a probe fails it. */
export const WAITING_LIMIT_SECONDS = 15 * 60;

/** One recovery attempt, as before: the turn is resumed once, and the next vanished owner fails it. */
export const DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS = 1;

/** The reason on a turn that vanished owners could not finish. */
export const RECOVERY_EXHAUSTED_REASON = "recovery attempts exhausted";

/** The reason on a turn that waited on its computer past the limit. */
export const COMPUTER_UNAVAILABLE_REASON = "computer unavailable";

/**
 * A stable identifier of one logical queue delivery for a turn, so a retried enqueue is recognised.
 *
 * @param turnId The turn.
 * @param recoveryAttempt The recovery attempt the delivery belongs to; omitted for the first delivery.
 * @returns `<turn>#initial` or `<turn>#recovery-<n>`.
 */
export function logicalEnqueueId(turnId: string, recoveryAttempt?: number): string {
	if (recoveryAttempt === undefined) return `${turnId}#initial`;
	return `${turnId}#recovery-${recoveryAttempt}`;
}

/** The identifier of the run a probe requests to finish a turn whose model already answered. */
export const finalizeEnqueueId = (turnId: string): string => `${turnId}#finalize`;

/** The identifier of the run an owner requests when it hands its turn on near the end of its function time. */
export const yieldEnqueueId = (turnId: string, attempt: number): string => `${turnId}#yield-${attempt}`;

/** Where a logical enqueue is remembered, so a retry can tell it was already delivered. */
export interface LogicalEnqueueRecorder {
	recordLogicalEnqueue(tenantId: string, turnId: string, enqueueId: string): Promise<boolean>;
}

/** What a logical enqueue needs. */
export type LogicalEnqueueDependencies = {
	readonly recorder: LogicalEnqueueRecorder;
	readonly turnRuns: TurnRunQueue;
	readonly faults?: FaultPlan;
};

/**
 * Publish a run job at most once per `enqueueId`: the identifier is recorded on the turn first, then the job is sent.
 *
 * @returns false when the identifier was already recorded and nothing was sent.
 */
export async function requestLogicalEnqueue(
	deps: LogicalEnqueueDependencies,
	job: TurnRunJob,
	enqueueId: string,
): Promise<boolean> {
	deps.faults?.maybeCrash("logical_enqueue", "before");
	if (!(await deps.recorder.recordLogicalEnqueue(job.tenantId, job.turnId, enqueueId))) return false;
	deps.faults?.maybeCrash("logical_enqueue", "after");
	await deps.turnRuns.enqueue(job);
	return true;
}

const clampDelay = (seconds: number): number => Math.min(MAXIMUM_PROBE_DELAY_SECONDS, Math.max(1, Math.ceil(seconds)));

/**
 * Arm one deadline probe for the turn's current attempt count.
 *
 * @param probes The probe queue.
 * @param turn The turn as last read.
 * @param delaySeconds How long to hold the probe back.
 */
export async function armProbe(probes: TurnProbeQueue, turn: Turn, delaySeconds: number): Promise<void> {
	await probes.send(
		{ tenantId: turn.tenantId, turnId: turn.turnId, kind: "deadline", expectAttempt: turn.attempt },
		clampDelay(delaySeconds),
	);
}

/** The run job that resumes a turn. */
export const runJobFor = (turn: Turn): TurnRunJob => ({
	tenantId: turn.tenantId,
	channelId: turn.channelId,
	botId: turn.botId,
	turnId: turn.turnId,
	requiredCapabilities: ["cpu"],
});

/** Reads the conversation of a turn without owning it. */
export interface SubmissionInspector {
	/** Whether the Pi session already holds a finished answer for the turn's prompt. */
	turnAnswered(turn: Turn): Promise<boolean>;
}

/** What a probe reads and writes. */
export type ProbeDependencies = {
	readonly turns: TurnDependencies;
	readonly turnRuns: TurnRunQueue;
	readonly turnProbes: TurnProbeQueue;
	readonly submissions: SubmissionInspector;
	readonly maximumRecoveryAttempts?: number;
	readonly faults?: FaultPlan;
};

const secondsBetween = (later: Date, earlier: Date): number => (later.getTime() - earlier.getTime()) / 1000;

/**
 * Resume a recovered turn: request its next run once and watch it again after the deadline. Safe to repeat, so a probe
 * that died between the two steps can be redelivered.
 */
async function resumeRecovery(deps: ProbeDependencies, turn: Turn): Promise<void> {
	await requestLogicalEnqueue(
		{ recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
		runJobFor(turn),
		logicalEnqueueId(turn.turnId, turn.recoveryAttempts),
	);
	await armProbe(deps.turnProbes, turn, TURN_DEADLINE_SECONDS);
}

async function handleUnownedTurn(deps: ProbeDependencies, turn: Turn): Promise<void> {
	if (turn.recoveryAttempts < (deps.maximumRecoveryAttempts ?? DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS)) {
		deps.faults?.maybeCrash("deadline_recovery", "before");
		const recovered = await recoverExpiredTurn(deps.turns, turn);
		if (recovered === null) return;
		deps.faults?.maybeCrash("deadline_recovery", "after");
		await resumeRecovery(deps, recovered);
		return;
	}
	if (await deps.submissions.turnAnswered(turn)) {
		const requested = await requestLogicalEnqueue(
			{ recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
			runJobFor(turn),
			finalizeEnqueueId(turn.turnId),
		);
		if (requested) {
			await armProbe(deps.turnProbes, turn, TURN_DEADLINE_SECONDS);
			return;
		}
	}
	await failStaleTurn(deps.turns, turn, "lease_expired", RECOVERY_EXHAUSTED_REASON);
}

/**
 * Handle one deadline probe. A probe checks the turn itself, so nothing ever cancels one:
 *
 * - a finished turn drops it;
 * - a turn waiting on a gate is watched again, and failed once it has waited past the limit;
 * - a live lease is watched again when it runs out, and so is a turn that no attempt holds (just recovered, or handed on)
 *   until its deadline;
 * - an expired lease means the owner vanished: the turn is resumed within the recovery budget, finished when its
 *   conversation already holds the answer, and failed when nothing is left to try.
 *
 * A probe armed for an earlier attempt than the turn is now on is obsolete while the turn is owned or waiting (the newer
 * attempt armed its own), but still acts when the lease has run out.
 *
 * @param deps Stores, queues and the conversation inspector.
 * @param message The probe.
 */
export async function handleProbe(deps: ProbeDependencies, message: TurnProbeMessage): Promise<void> {
	const turn = await deps.turns.store.getTurn(message.tenantId, message.turnId);
	if (turn === null || turn.status !== "active") return;
	const superseded = turn.attempt > message.expectAttempt;
	const now = deps.turns.clock.now();
	if (turn.waitingFor !== null) {
		if (superseded) return;
		const since = turn.waitingSince ?? turn.deadlineAt ?? now;
		const remaining = WAITING_LIMIT_SECONDS - secondsBetween(now, since);
		if (remaining <= 0) {
			await failStaleTurn(deps.turns, turn, "waiting", COMPUTER_UNAVAILABLE_REASON);
			return;
		}
		await armProbe(deps.turnProbes, turn, Math.min(remaining, ATTEMPT_LEASE_SECONDS));
		return;
	}
	const recoveryId = logicalEnqueueId(turn.turnId, turn.recoveryAttempts);
	if (turn.attemptId === null && turn.recoveryAttempts > 0 && !turn.logicalEnqueueIds.includes(recoveryId)) {
		await resumeRecovery(deps, turn);
		return;
	}
	const ownedUntil = turn.leaseExpiresAt ?? turn.deadlineAt;
	if (ownedUntil !== null && ownedUntil.getTime() > now.getTime()) {
		if (superseded) return;
		await armProbe(deps.turnProbes, turn, secondsBetween(ownedUntil, now));
		return;
	}
	await handleUnownedTurn(deps, turn);
}
