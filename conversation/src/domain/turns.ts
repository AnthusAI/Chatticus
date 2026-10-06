import type { Clock, IdSource } from "../http/app.ts";
import { StaleAttemptError, TurnNotFoundError, TurnTerminalError } from "../http/errors.ts";
import { pythonRepr } from "./bots.ts";

/** Seconds an attempt owns a turn before another attempt may claim it. */
export const ATTEMPT_LEASE_SECONDS = 60;

/** Seconds from a claim or renewal until the deadline probe considers the attempt late. */
export const TURN_DEADLINE_SECONDS = 120;

/** Seconds a turn event item lives before DynamoDB expires it. */
export const TURN_EVENT_TTL_SECONDS = 24 * 60 * 60;

/** Where a turn is in its life; waiting is `active` with `waitingFor` set. */
export type TurnStatus = "active" | "completed" | "failed" | "reconciling";

/** The kinds of durable turn event the stream and the events route carry. */
export type TurnEventKind =
	| "turn.started"
	| "attempt.claimed"
	| "model.request"
	| "turn.token"
	| "tool.call"
	| "tool.result"
	| "turn.waiting"
	| "attempt.relinquished"
	| "turn.completed"
	| "turn.failed"
	| "turn.reconciling";

/** The computer tool call a waiting turn is parked on. */
export type PendingComputerTool = {
	actionId: string;
	toolName: string;
	arguments: Record<string, string>;
};

/** The turn control record, `{tenant}#turn#{id}` / `meta`. */
export type Turn = {
	turnId: string;
	tenantId: string;
	channelId: string;
	botId: string;
	status: TurnStatus;
	promptMessageSeq: number | null;
	attemptId: string | null;
	attempt: number;
	claimedBy: string | null;
	leaseExpiresAt: Date | null;
	deadlineAt: Date | null;
	recoveryAttempts: number;
	waitingFor: string | null;
	pendingComputerTool: PendingComputerTool | null;
	storageFence: number | null;
	nextEventSeq: number;
	terminalReason: string | null;
	messageSeq: number | null;
	ledgerInputRecorded: number;
	ledgerOutputRecorded: number;
};

/** One durable turn event with its integer sequence within the turn. */
export type TurnEvent = {
	eventId: string;
	tenantId: string;
	turnId: string;
	channelId: string;
	seq: number;
	kind: TurnEventKind;
	token?: string;
	messageSeq?: number;
	body?: string;
	pendingComputerTool?: PendingComputerTool;
	actionId?: string;
	attemptId?: string;
};

/** What a caller says about an event; the store assigns the sequence and the domain assigns the identifier. */
export type TurnEventDraft = {
	kind: TurnEventKind;
	token?: string;
	messageSeq?: number;
	body?: string;
	pendingComputerTool?: PendingComputerTool;
	actionId?: string;
	attemptId?: string;
};

/** What a successful claim hands the owner. */
export type TurnClaim = {
	turn: Turn;
	attemptId: string;
	attempt: number;
	leaseExpiresAt: Date;
	deadlineAt: Date;
};

/** The conditional writes of the turn control record; the Messaging table implements them. */
export interface TurnControlStore {
	/** The turn record, or null when the turn does not exist. */
	getTurn(tenantId: string, turnId: string): Promise<Turn | null>;
	/** The compare-and-set of section 3.2 step 1; null when the condition fails. */
	claimTurn(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		claimedBy: string | null;
		now: Date;
		leaseExpiresAt: Date;
		deadlineAt: Date;
	}): Promise<Turn | null>;
	/** Extend the lease and deadline of the attempt; null when the attempt no longer owns the turn. */
	renewTurn(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		leaseExpiresAt: Date;
		deadlineAt: Date;
	}): Promise<Turn | null>;
	/** Record the Pi storage fence the attempt opened its session with. */
	recordStorageFence(tenantId: string, turnId: string, attemptId: string, storageFence: number): Promise<void>;
	/**
	 * Append one event under the fence of `attemptId`.
	 *
	 * @throws StaleAttemptError If the attempt no longer owns the turn.
	 * @throws TurnTerminalError If the turn is no longer active.
	 */
	appendEvent(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		draft: TurnEventDraft;
		eventId: string;
		expiresAt: Date;
	}): Promise<TurnEvent>;
	/** Complete the turn and append turn.completed in one transaction under the attempt's fence. */
	completeTurn(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		messageSeq: number;
		body: string;
		eventId: string;
		expiresAt: Date;
	}): Promise<TurnEvent>;
	/** Fail the turn and append turn.failed in one transaction under the attempt's fence. */
	failTurn(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		reason: string;
		eventId: string;
		expiresAt: Date;
	}): Promise<TurnEvent>;
	/**
	 * Mark the turn closing under the attempt's fence: it stops accepting steered messages, so the owner's last drain
	 * of the mailbox sees every message that will ever be steered into this turn.
	 *
	 * @throws StaleAttemptError If the attempt no longer owns the turn.
	 * @throws TurnTerminalError If the turn is no longer active.
	 */
	beginClosing(tenantId: string, turnId: string, attemptId: string): Promise<void>;
	/** Mark the turn reconciling and append turn.reconciling in one transaction under the attempt's fence. */
	reconcileTurn(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		reason: string;
		eventId: string;
		expiresAt: Date;
	}): Promise<TurnEvent>;
	/** Park the turn on a gate: set waiting_for, drop the claim and append turn.waiting in one transaction. */
	parkTurn(request: {
		tenantId: string;
		turnId: string;
		attemptId: string;
		gate: string;
		pendingComputerTool: PendingComputerTool;
		eventId: string;
		expiresAt: Date;
	}): Promise<TurnEvent>;
	/** The events of a turn after a sequence, in sequence order. */
	listEvents(tenantId: string, turnId: string, afterSeq: number): Promise<TurnEvent[]>;
	/** The turn a channel pointer names, or null when the pointer is absent. */
	pointedTurn(
		tenantId: string,
		channelId: string,
		pointer: "active" | "latest",
		botId: string | null,
	): Promise<Turn | null>;
}

/** Everything the turn functions read and write. */
export type TurnDependencies = {
	store: TurnControlStore;
	clock: Clock;
	ids: IdSource;
};

const addSeconds = (moment: Date, seconds: number): Date => new Date(moment.getTime() + seconds * 1000);

/**
 * Return one turn.
 *
 * @throws TurnNotFoundError If the turn is unknown.
 */
export async function getTurn(deps: TurnDependencies, tenantId: string, turnId: string): Promise<Turn> {
	const turn = await deps.store.getTurn(tenantId, turnId);
	if (turn === null) {
		throw new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
	}
	return turn;
}

/**
 * Conditionally become the owner of an active turn: the turn must be active, not waiting, and its lease absent or
 * expired. Sets the attempt, increments the attempt count, and sets the lease and deadline.
 *
 * @param claimedBy Optional label of the process claiming, recorded as `claimed_by`.
 * @returns The claim, or null when a live owner exists or the turn cannot be claimed.
 * @throws TurnNotFoundError If the turn is unknown.
 */
export async function claimTurn(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	claimedBy: string | null = null,
): Promise<TurnClaim | null> {
	await getTurn(deps, tenantId, turnId);
	const now = deps.clock.now();
	const leaseExpiresAt = addSeconds(now, ATTEMPT_LEASE_SECONDS);
	const deadlineAt = addSeconds(now, TURN_DEADLINE_SECONDS);
	const turn = await deps.store.claimTurn({ tenantId, turnId, attemptId, claimedBy, now, leaseExpiresAt, deadlineAt });
	if (turn === null || turn.attemptId === null) {
		return null;
	}
	return { turn, attemptId: turn.attemptId, attempt: turn.attempt, leaseExpiresAt, deadlineAt };
}

/**
 * Extend the lease and deadline of the attempt that owns the turn.
 *
 * @returns The renewed claim, or null when the attempt no longer owns the turn (the owner is stale).
 */
export async function renewTurn(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
): Promise<TurnClaim | null> {
	const now = deps.clock.now();
	const leaseExpiresAt = addSeconds(now, ATTEMPT_LEASE_SECONDS);
	const deadlineAt = addSeconds(now, TURN_DEADLINE_SECONDS);
	const turn = await deps.store.renewTurn({ tenantId, turnId, attemptId, leaseExpiresAt, deadlineAt });
	if (turn === null || turn.attemptId === null) {
		return null;
	}
	return { turn, attemptId: turn.attemptId, attempt: turn.attempt, leaseExpiresAt, deadlineAt };
}

/**
 * Record the Pi storage fence the owner opened its session with.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 */
export async function recordStorageFence(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	storageFence: number,
): Promise<void> {
	await deps.store.recordStorageFence(tenantId, turnId, attemptId, storageFence);
}

/**
 * Append one event to a turn under the fence of the attempt.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function appendTurnEvent(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	draft: TurnEventDraft,
): Promise<TurnEvent> {
	return deps.store.appendEvent({
		tenantId,
		turnId,
		attemptId,
		draft,
		eventId: deps.ids.next(),
		expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS),
	});
}

/**
 * Mark the turn closing: from now on a message addressed to the turn's bot starts the next turn instead of steering
 * this one.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function beginClosing(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
): Promise<void> {
	await deps.store.beginClosing(tenantId, turnId, attemptId);
}

/**
 * Hand an active turn to reconciliation because the owner cannot know what it committed, appending turn.reconciling.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function reconcileTurn(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	reason: string,
): Promise<TurnEvent> {
	return deps.store.reconcileTurn({
		tenantId,
		turnId,
		attemptId,
		reason,
		eventId: deps.ids.next(),
		expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS),
	});
}

/**
 * Park the turn on a readiness gate. The turn stays active with `waitingFor` set, the claim is dropped so a later
 * attempt can continue the same durable turn, and turn.waiting is appended.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function releaseForWaiting(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	gate: string,
): Promise<TurnEvent> {
	return deps.store.parkTurn({
		tenantId,
		turnId,
		attemptId,
		gate,
		pendingComputerTool: { actionId: deps.ids.next(), toolName: "request_computer_capability", arguments: { gate } },
		eventId: deps.ids.next(),
		expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS),
	});
}

/**
 * End an active turn as failed on behalf of its owner. The reason is shown to the member.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn is no longer active.
 */
export async function failTurn(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	reason: string,
): Promise<TurnEvent> {
	return deps.store.failTurn({
		tenantId,
		turnId,
		attemptId,
		reason,
		eventId: deps.ids.next(),
		expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS),
	});
}

/**
 * Complete an active turn under the owner's fence, appending turn.completed. Completing a turn the same attempt
 * already completed returns the event that completed it and appends nothing.
 *
 * @throws StaleAttemptError If the attempt no longer owns the turn.
 * @throws TurnTerminalError If the turn ended some other way.
 */
export async function completeTurn(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	attemptId: string,
	messageSeq: number,
	body: string,
): Promise<TurnEvent> {
	const current = await getTurn(deps, tenantId, turnId);
	if (current.status === "completed") {
		if (current.attemptId !== attemptId) {
			throw new StaleAttemptError(
				`Turn ${pythonRepr(turnId)} rejected attempt ${pythonRepr(attemptId)} (current ${pythonRepr(current.attemptId ?? "")}).`,
			);
		}
		const events = await deps.store.listEvents(tenantId, turnId, 0);
		const completion = events.findLast((event) => event.kind === "turn.completed");
		if (completion === undefined) {
			throw new TurnTerminalError(`Turn ${pythonRepr(turnId)} is completed but has no completion event.`);
		}
		return completion;
	}
	return deps.store.completeTurn({
		tenantId,
		turnId,
		attemptId,
		messageSeq,
		body,
		eventId: deps.ids.next(),
		expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS),
	});
}

/** The events of a turn after a sequence. */
export async function listTurnEvents(
	deps: TurnDependencies,
	tenantId: string,
	turnId: string,
	afterSeq: number,
): Promise<TurnEvent[]> {
	await getTurn(deps, tenantId, turnId);
	return deps.store.listEvents(tenantId, turnId, afterSeq);
}

/**
 * The active turn of a channel: the addressed bot's when `botId` is given, otherwise the most recently started active
 * turn across the channel's bots.
 *
 * @returns The turn, or null when none is active.
 */
export async function activeTurnForChannel(
	deps: TurnDependencies,
	tenantId: string,
	channelId: string,
	botId: string | null,
): Promise<Turn | null> {
	const turn = await deps.store.pointedTurn(tenantId, channelId, "active", botId);
	return turn !== null && turn.status === "active" ? turn : null;
}

/**
 * The latest turn of a channel in any status: the addressed bot's when `botId` is given, otherwise the most recently
 * started turn across the channel's bots.
 *
 * @returns The turn, or null when the channel has had none.
 */
export async function latestTurnForChannel(
	deps: TurnDependencies,
	tenantId: string,
	channelId: string,
	botId: string | null,
): Promise<Turn | null> {
	return deps.store.pointedTurn(tenantId, channelId, "latest", botId);
}
