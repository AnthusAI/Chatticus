import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Context } from "@earendil-works/chord";
import type { Extension } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { VendorLedgerDependencies } from "../ledger/vendor-ledger.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { TurnDependencies } from "../domain/turns.ts";
import type { TurnProbeQueue, TurnRunQueue, TurnRunVisibility } from "../domain/turn-admission.ts";
import type { ComputerToolHandoff } from "../pi/computer-tools.ts";
import type { OwnerSessionDependencies } from "../pi/session.ts";
import type { ComputerHandoffDependencies } from "./park.ts";
import type { FaultPlan } from "./fault-plan.ts";

/** The queue message that asks an executor to run a turn. */
export type TurnExecutionJob = {
	readonly tenantId: string;
	readonly turnId: string;
	readonly botId: string;
};

/**
 * How one execution ended.
 *
 * - `done`: the turn completed and its answer is committed to the channel.
 * - `failed`: the turn ended as failed with a reason a member can read.
 * - `lost`: another attempt owns the turn (or it already ended); nothing was written for it.
 * - `reconciling`: a Pi commit's outcome is unknown; the turn is handed to reconciliation.
 * - `yielded`: the function was close to its time limit; the claim is released and another run is queued.
 * - `parked`: the turn called a computer tool with no answer yet; its action is recorded, the turn waits on its gate with
 *   no owner, and the host's result will queue the run that resumes it.
 */
export type TurnExecutionOutcome = "done" | "failed" | "lost" | "reconciling" | "yielded" | "parked";

/** The model every turn of a bot runs on. */
export type TurnModel = { readonly provider: string; readonly modelId: string; readonly thinkingLevel: ModelThinkingLevel };

/** Timing and retry knobs; the defaults are the design's. */
export type ExecutorTuning = {
	/** Milliseconds between lease renewals. */
	readonly renewIntervalMilliseconds: number;
	/** Milliseconds between looks at the mailbox for steered messages. */
	readonly mailboxPollMilliseconds: number;
	/** Bytes of streamed text that are written at once. */
	readonly tokenFlushBytes: number;
	/** Milliseconds after which streamed text is written however small. */
	readonly tokenFlushMilliseconds: number;
	/** Remaining function milliseconds under which an owner hands its turn on. */
	readonly yieldBelowMilliseconds: number;
	/** Pi's retry policy for a failed model call. */
	readonly retry: { readonly maxRetries: number; readonly baseDelayMilliseconds: number };
};

/** What an executor tells an observer about the turn's claim; it never carries a secret or any of the turn's content. */
export type TurnAttemptObserver = {
	/** The attempt that now owns the turn, with its attempt number. */
	readonly claimed?: (attemptId: string, attempt: number) => void;
	/** The turn is not this owner's: another owner won the claim (`claim`), or took the turn while this one ran (`running`). */
	readonly lost?: (phase: "claim" | "running") => void;
};

/** Everything an execution reads and writes. */
export type ExecutorDeps = {
	readonly turns: TurnDependencies;
	readonly messaging: MessagingStore;
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly piSessionsBucket: string;
	readonly models: Models;
	readonly model: TurnModel;
	readonly ledger: VendorLedgerDependencies;
	/** Recorded as `claimed_by` on the turn. */
	readonly workerLabel?: string;
	readonly tuning?: Partial<ExecutorTuning>;
	readonly context?: Context;
	/** Where yield and recovery publish run jobs. */
	readonly turnRuns: TurnRunQueue;
	/** Where the executor arms deadline probes. */
	readonly turnProbes: TurnProbeQueue;
	/** Keeps the run job invisible to other consumers while the attempt works. */
	readonly runVisibility: TurnRunVisibility;
	/** The function's remaining time, `context.getRemainingTimeInMillis` in the Lambda; absent when time is unbounded. */
	readonly remainingMilliseconds?: () => number;
	/** The computer handoff: actions, start jobs and the spend ceiling pause. */
	readonly computer: ComputerHandoffDependencies;
	/**
	 * Builds the extension that supplies the computer tools of the session. Absent, the owner registers the remote tools
	 * that record an action and park the turn for a host; a computer owner registers local tools instead.
	 */
	readonly computerTools?: (handoff: ComputerToolHandoff) => Extension;
	/** The execution environment of Pi's own tools, passed to the session; only an owner that runs them sets it. */
	readonly env?: OwnerSessionDependencies["env"];
	/** Crash injection for tests; never set in production. */
	readonly faults?: FaultPlan;
	/** Told when the turn is claimed or lost; absent for an owner nobody observes. */
	readonly observer?: TurnAttemptObserver;
};
