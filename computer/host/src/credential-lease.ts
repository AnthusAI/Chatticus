import {
	OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS,
	OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS,
	OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS,
	OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS,
	OWNER_CREDENTIAL_RENEWAL_RETRY_SECONDS,
} from "@chatticus/host-protocol/supervisor";
import type { TurnCredentials, TurnCredentialSource } from "./supervisor-ports.ts";

/**
 * The credentials one holder serves right now. The value is replaced as a whole and never mutated, so a reader that took
 * the current value keeps a consistent set for as long as it holds it.
 */
export class CredentialHolder<T extends { readonly expires_at: string }> {
	private value: T;

	constructor(initial: T) {
		this.value = initial;
	}

	/** The set in force right now. */
	current(): T {
		return this.value;
	}

	/** Put a whole new set in force; the next reader sees it, a reader that already took the old set keeps it. */
	replace(next: T): void {
		this.value = next;
	}
}

/** Where a credential set is in its life, from the state table of the renewal contract. */
export type CredentialState = "valid" | "renewing" | "refused" | "expiring" | "expired";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The schedule of one credential set that gets renewed: when to ask for the next set, how long to pause after a failure,
 * and when the owner has to drain and to give up. It holds no credential, only times and counters, and makes no request
 * itself: the caller starts a renewal when {@link CredentialLease.isDue} and reports the outcome.
 */
export class CredentialLease {
	private expiresAtMilliseconds: number;
	private lastSuccessAtMilliseconds: number;
	private nextAttemptAtMilliseconds = 0;
	private failures = 0;
	private requestInFlight = false;
	private refusedForGood = false;

	/**
	 * @param expiresAtMilliseconds When the set in hand ends.
	 * @param acquiredAtMilliseconds When it was received; the first renewal is never sooner than the minimum interval after it.
	 */
	constructor(expiresAtMilliseconds: number, acquiredAtMilliseconds: number) {
		this.expiresAtMilliseconds = expiresAtMilliseconds;
		this.lastSuccessAtMilliseconds = acquiredAtMilliseconds;
	}

	/** When the set in hand ends. */
	get expiresAt(): number {
		return this.expiresAtMilliseconds;
	}

	/** How many renewals in a row failed since the last success. */
	get consecutiveFailures(): number {
		return this.failures;
	}

	/** Whether a renewal request is out. */
	get inFlight(): boolean {
		return this.requestInFlight;
	}

	/** Whether the control plane refused renewal for good. */
	get refused(): boolean {
		return this.refusedForGood;
	}

	/** Whole milliseconds left, negative once the set has ended. */
	remainingMilliseconds(nowMilliseconds: number): number {
		return this.expiresAtMilliseconds - nowMilliseconds;
	}

	/** When the next renewal is due, or infinity while one is out or after a final refusal. */
	dueAtMilliseconds(): number {
		if (this.requestInFlight || this.refusedForGood) return Number.POSITIVE_INFINITY;
		const server = this.lastSuccessAtMilliseconds + OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS * MILLISECONDS_PER_SECOND;
		return Math.max(this.renewalStartsAtMilliseconds(), server, this.failures > 0 ? this.nextAttemptAtMilliseconds : 0);
	}

	/** When the set in hand has the renewal margin left: the moment renewing begins, before the pauses of failures and the server's interval. */
	renewalStartsAtMilliseconds(): number {
		return this.expiresAtMilliseconds - OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS * MILLISECONDS_PER_SECOND;
	}

	/** Whether a renewal should be started now. */
	isDue(nowMilliseconds: number): boolean {
		return nowMilliseconds >= this.dueAtMilliseconds();
	}

	/** When the owner has to start draining on its own if no renewal has succeeded. */
	localDrainAtMilliseconds(): number {
		return this.expiresAtMilliseconds - OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS * MILLISECONDS_PER_SECOND;
	}

	/** When the owner must have exited: a stop that is still running then is cut short. */
	hardDeadlineAtMilliseconds(): number {
		return this.expiresAtMilliseconds - OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS * MILLISECONDS_PER_SECOND;
	}

	/** The state of the set at the given time. */
	state(nowMilliseconds: number): CredentialState {
		if (nowMilliseconds >= this.expiresAtMilliseconds) return "expired";
		if (nowMilliseconds >= this.localDrainAtMilliseconds()) return "expiring";
		if (this.refusedForGood) return "refused";
		if (nowMilliseconds >= this.renewalStartsAtMilliseconds()) return "renewing";
		return "valid";
	}

	/** Record that a renewal request went out. */
	beginRenewal(): void {
		this.requestInFlight = true;
	}

	/** Record a renewal that was swapped in: the new end, the counters back to zero. */
	succeeded(nowMilliseconds: number, expiresAtMilliseconds: number): void {
		this.requestInFlight = false;
		this.expiresAtMilliseconds = expiresAtMilliseconds;
		this.lastSuccessAtMilliseconds = nowMilliseconds;
		this.failures = 0;
		this.nextAttemptAtMilliseconds = 0;
	}

	/** Record a renewal that failed and schedule the next attempt after the pause its failure count calls for. */
	failed(nowMilliseconds: number): void {
		this.requestInFlight = false;
		this.failures += 1;
		const pauses = OWNER_CREDENTIAL_RENEWAL_RETRY_SECONDS;
		this.nextAttemptAtMilliseconds = nowMilliseconds + pauses[Math.min(this.failures, pauses.length) - 1]! * MILLISECONDS_PER_SECOND;
	}

	/** Record that the control plane said no for good; no further attempt is due. */
	refuse(): void {
		this.requestInFlight = false;
		this.refusedForGood = true;
	}

	/** Forget an outstanding request without recording an outcome, for a renewal that was abandoned. */
	abandon(): void {
		this.requestInFlight = false;
	}
}

/**
 * The credentials of the one turn the supervisor serves: the set the dispatch carried and its renewals, from the moment the
 * child starts until it exits. It answers the socket server for its own dispatch and for no other.
 */
export class TurnCredentialLease implements TurnCredentialSource {
	readonly dispatchId: string;
	readonly turnId: string;
	readonly schedule: CredentialLease;
	private readonly holder: CredentialHolder<TurnCredentials>;

	constructor(dispatchId: string, turnId: string, credentials: TurnCredentials, nowMilliseconds: number) {
		this.dispatchId = dispatchId;
		this.turnId = turnId;
		this.holder = new CredentialHolder(credentials);
		this.schedule = new CredentialLease(Date.parse(credentials.expires_at), nowMilliseconds);
	}

	/** The credentials held for this dispatch, even past their end (the caller tells an expired set from a missing one), or null for another dispatch. */
	current(dispatchId: string): TurnCredentials | null {
		return dispatchId === this.dispatchId ? this.holder.current() : null;
	}

	/** Put a renewed set in force. */
	replace(credentials: TurnCredentials): void {
		this.holder.replace(credentials);
	}
}
