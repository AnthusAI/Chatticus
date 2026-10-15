/**
 * The durable steps of one bot turn at which a crash can be injected. The first eight are the Python fault hooks'; the
 * last three are the computer handoff's: the action record, the park of the turn, and the start job.
 */
export type TurnBoundary =
	| "message_commit"
	| "logical_enqueue"
	| "worker_claim"
	| "model_acceptance"
	| "progress_append"
	| "completion_append"
	| "acknowledgement"
	| "deadline_recovery"
	| "computer_action"
	| "computer_park"
	| "computer_start";

/** Whether the crash happens before or after the durable write of its boundary. */
export type CrashWindow = "before" | "after";

/** Every boundary, in the order a turn meets them. */
export const TURN_BOUNDARIES: readonly TurnBoundary[] = [
	"message_commit",
	"logical_enqueue",
	"worker_claim",
	"model_acceptance",
	"progress_append",
	"completion_append",
	"acknowledgement",
	"deadline_recovery",
	"computer_action",
	"computer_park",
	"computer_start",
];

/** Raised by an armed fault hook; stands for a process that disappeared at that point. */
export class SimulatedCrash extends Error {
	readonly boundary: TurnBoundary;
	readonly window: CrashWindow;

	constructor(boundary: TurnBoundary, window: CrashWindow) {
		super(`simulated crash ${boundary} ${window}`);
		this.name = "SimulatedCrash";
		this.boundary = boundary;
		this.window = window;
	}
}

/** Fires at most one deterministic crash, at the boundary and window it was armed with. */
export class FaultPlan {
	private armedAt: { boundary: TurnBoundary; window: CrashWindow } | null = null;
	private firedAt: { boundary: TurnBoundary; window: CrashWindow } | null = null;

	/** Arm the next pass through `boundary` / `window`; a plan that already fired fires again once re-armed. */
	arm(boundary: TurnBoundary, window: CrashWindow): void {
		this.armedAt = { boundary, window };
		this.firedAt = null;
	}

	/** Disable any further crash. */
	clear(): void {
		this.armedAt = null;
	}

	/** Where the plan fired, or null while it has not. */
	get crashedAt(): { boundary: TurnBoundary; window: CrashWindow } | null {
		return this.firedAt;
	}

	/**
	 * The hook the production code calls at every boundary.
	 *
	 * @throws SimulatedCrash When the plan is armed at exactly this boundary and window and has not fired yet.
	 */
	maybeCrash(boundary: TurnBoundary, window: CrashWindow): void {
		if (this.armedAt === null || this.firedAt !== null) return;
		if (this.armedAt.boundary !== boundary || this.armedAt.window !== window) return;
		this.firedAt = { boundary, window };
		throw new SimulatedCrash(boundary, window);
	}
}
