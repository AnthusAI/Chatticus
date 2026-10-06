import type {
	TurnProbeQueue,
	TurnRunJob,
	TurnRunQueue,
	TurnRunVisibility,
} from "../src/domain/turn-admission.ts";
import type { ChatticusWorld } from "./world.ts";

/** The queue name run jobs are recorded under in the scenario's queue recorder. */
export const TURN_RUN_QUEUE = "turn-runs";

/** The queue name deadline probes are recorded under; the recorder holds each back for its delay on the fake clock. */
export const TURN_PROBE_QUEUE = "turn-probes";

/** The scenario's TurnRuns queue. */
export const runQueueOf = (world: ChatticusWorld): TurnRunQueue => ({
	async enqueue(job: TurnRunJob): Promise<void> {
		world.queues.send(TURN_RUN_QUEUE, job);
	},
});

/** The scenario's TurnProbes delay queue. */
export const probeQueueOf = (world: ChatticusWorld): TurnProbeQueue => ({
	async send(message, delaySeconds): Promise<void> {
		world.queues.send(TURN_PROBE_QUEUE, message, delaySeconds);
	},
});

/** Records every extension of a run job's visibility, as SQS would receive it. */
export const runVisibilityOf = (world: ChatticusWorld): TurnRunVisibility => ({
	async extend(tenantId, turnId): Promise<void> {
		world.runVisibilityExtensions.push({ tenantId, turnId });
	},
});
