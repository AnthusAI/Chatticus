/**
 * The queue pieces of the executor that only a Lambda has: the run queue, the probe delay queue and the visibility of the
 * run job being worked on. A computer owner is not an SQS consumer and holds no queue rights, so it supplies these
 * instead. They send nothing: a turn the computer owner finishes needs no run job, and a turn it loses to a crash is
 * found by the probe armed when the turn parked.
 */

import type { TurnProbeQueue, TurnRunQueue, TurnRunVisibility } from "../domain/turn-admission.ts";

/** A run queue that accepts every job and publishes none. */
export const NO_OP_TURN_RUNS: TurnRunQueue = {
	async enqueue(): Promise<void> {},
};

/** A probe queue that accepts every probe and publishes none. */
export const NO_OP_TURN_PROBES: TurnProbeQueue = {
	async send(): Promise<void> {},
};

/** A run job visibility that has no message to extend. */
export const NO_OP_RUN_VISIBILITY: TurnRunVisibility = {
	async extend(): Promise<void> {},
};
