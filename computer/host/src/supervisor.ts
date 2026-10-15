import { OVERLAY_CLEAR_RETRY_SECONDS, OVERLAY_EARLY_PUBLISH_SECONDS } from "@chatticus/host-protocol/edit-overlay";
import {
	OWNER_CHILD_FAILURE_LIMIT,
	OWNER_DRAIN_GRACE_SECONDS,
	OWNER_IDLE_TIMEOUT_SECONDS,
	OWNER_PERIODIC_PUBLISH_SECONDS,
	OWNER_POLL_SILENCE_FENCE_SECONDS,
	OWNER_PROTOCOL_VERSION,
	OWNER_QUIET_PUBLISH_SECONDS,
	OWNER_STOP_RETRY_SECONDS,
	type AwsCredentials,
	type OwnerCredentialsRequest,
	type OwnerCredentialsResponse,
	type OwnerDispatch,
	type OwnerPollRequest,
	type OwnerPollResponse,
	type OwnerState,
	type OwnerStopReason,
} from "@chatticus/host-protocol/supervisor";
import type { LiveFileOutcome } from "@chatticus/host-protocol/live-files";
import { errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import { CredentialHolder, CredentialLease, TurnCredentialLease } from "./credential-lease.ts";
import { LiveFileOperations } from "./live-file-operations.ts";
import type { FileHelperLauncher } from "./live-file-helper-launcher.ts";
import { OverlayApplyError, type OverlayEntryReference } from "./overlay-applier.ts";
import { HostProtocolError, refusalEndsOwnership } from "./protocol-client.ts";
import { buildOwnerChildEnvironment } from "./supervisor-child-environment.ts";
import {
	SUPERVISOR_EXIT_BOOTSTRAP_FAILED,
	SUPERVISOR_EXIT_BOOT_FAILED,
	SUPERVISOR_EXIT_CREDENTIALS_EXPIRED,
	SUPERVISOR_EXIT_FENCED,
	SUPERVISOR_EXIT_SIGTERM,
	SUPERVISOR_EXIT_STOPPED,
	SUPERVISOR_EXIT_SUPERSEDED,
	type ChildExit,
	type ChildSpawner,
	type SpawnedChild,
	type StorageCredentialIdentity,
	type StorageCredentialsProvider,
	type SupervisorClock,
	type SupervisorDisk,
	type SupervisorPlane,
	type TurnCredentialSource,
	type UnprivilegedProcessSweeper,
} from "./supervisor-ports.ts";

const BOOTSTRAP_RETRY_WINDOW_MILLISECONDS = 120_000;
const BOOTSTRAP_RETRY_PAUSE_MILLISECONDS = 2000;
const POLL_FAILURE_PAUSES_MILLISECONDS = [1000, 2000, 4000, 5000] as const;
const TERMINATE_GRACE_AT_SIGTERM_MILLISECONDS = 5000;
const TERMINATE_GRACE_AT_DRAIN_MILLISECONDS = 10_000;
const STOPPED_REPORT_ATTEMPTS = 3;
const STOPPED_REPORT_PAUSE_MILLISECONDS = 2000;
const IDLE_LOG_INTERVAL_MILLISECONDS = 300_000;
const POLLING_LOG_INTERVAL_MILLISECONDS = 60_000;

const CLEAR_ATTEMPTS_BEFORE_STOPPED_REPORT = 3;
const CLEAR_ATTEMPT_PAUSE_MILLISECONDS = 1000;

/** Who the supervisor is. */
export type OwnerSupervisorIdentity = {
	readonly tenantId: string;
	/** The owner id the starter generated; also the worker id of the owner and the claim identity of every child. */
	readonly ownerId: string;
	/** The host start generation the starter claimed for this owner. */
	readonly generation: number;
};

/** What a supervisor runs on. Every effect is a port, so a scenario supplies fakes for all of them. */
export type OwnerSupervisorOptions = {
	readonly identity: OwnerSupervisorIdentity;
	/** The supervisor's own environment: the source of the settings the child shares. It is never modified. */
	readonly environment: NodeJS.ProcessEnv;
	readonly plane: SupervisorPlane;
	/**
	 * Opens the computer's disk once the bootstrap exchange has issued the supervisor's AWS credentials. It is called once; the
	 * storage client it builds asks the provider for the credentials of every request, so a renewal reaches it without a new client.
	 */
	readonly openDisk: (credentials: StorageCredentialsProvider) => SupervisorDisk;
	readonly spawner: ChildSpawner;
	readonly sweeper: UnprivilegedProcessSweeper;
	readonly clock: SupervisorClock;
	readonly log: LogEmitter;
	/** Percent of the container's memory in use, reported with every poll; absent or undefined, none is reported. */
	readonly memoryUsedPercent?: () => number | undefined;
	/** Starts the unprivileged file helper for one file request; the supervisor never opens a workspace path itself. */
	readonly fileHelperLauncher: FileHelperLauncher;
	/** The real directory that plays `/workspace` for file requests. */
	readonly workspaceRoot: string;
};

type RunningChild = {
	readonly handle: SpawnedChild;
	readonly dispatchId: string;
	readonly turnId: string;
	readonly botId: string;
	readonly startedAtMilliseconds: number;
};

type StopCause = OwnerStopReason | "sigterm";

type RenewalKind = "supervisor" | "turn";

type RenewalAttempt = {
	readonly kind: RenewalKind;
	readonly schedule: CredentialLease;
	readonly turn: TurnCredentialLease | null;
	readonly startedAtMilliseconds: number;
	readonly attempts: number;
	readonly remainingSecondsBefore: number;
};

class RenewalMismatchError extends Error {
	constructor() {
		super("the renewal answered a different kind, a different turn or no later end");
		this.name = "RenewalMismatchError";
	}
}

/**
 * The long-lived owner of the organization computer. After the bootstrap exchange it asks the control plane for work with a
 * poll that is also its heartbeat, restores the disk, runs each dispatched turn in a per-turn child that holds only that
 * turn's credentials, publishes a changed disk between turns, and stops itself when it has been idle, when the control plane
 * drains it, when it is unhealthy, or when the container is stopped. It fences itself when the control plane has not
 * answered for longer than the control plane waits before it counts the owner dead.
 *
 * It renews its own AWS credentials and token, and those of the turn it serves, twenty minutes before they end, as an
 * activity next to the poll. When its own renewals fail it drains ten minutes before its credentials end, stops with the
 * reason `credentials`, and exits with code 9 thirty seconds before they end if the stop is still running.
 */
export class OwnerSupervisor {
	private readonly options: OwnerSupervisorOptions;
	private readonly identity: OwnerSupervisorIdentity;
	private currentState: OwnerState = "booting";
	private exitCode: number | undefined;
	private sequence = 0;
	private wakeRequested = false;
	private wakeController: AbortController | null = null;
	private disk: SupervisorDisk | null = null;
	private hydrated = false;
	private activity: Promise<void> | null = null;
	private child: RunningChild | null = null;
	private startedAtMilliseconds = 0;
	private awsCredentials: CredentialHolder<AwsCredentials> | null = null;
	private supervisorLease: CredentialLease | null = null;
	private turnLease: TurnCredentialLease | null = null;
	private drainStopReason: "lifetime" | "credentials" = "lifetime";
	private lastSuccessfulPollAtMilliseconds = 0;
	private nextPollAtMilliseconds = 0;
	private consecutivePollFailures = 0;
	private pollsSinceLog = 0;
	private dispatchesSinceLog = 0;
	private failuresSinceLog = 0;
	private lastPollIntervalMilliseconds = 0;
	private nextPollingLogAtMilliseconds = 0;
	private idleStartedAtMilliseconds: number | null = null;
	private nextIdleLogAtMilliseconds = 0;
	private nextPublishCheckAtMilliseconds: number | null = null;
	private quietPublishDueAtMilliseconds: number | null = null;
	private stopRetryAtMilliseconds = 0;
	private consecutiveChildFailures = 0;
	private turnsServed = 0;
	private draining = false;
	private drainStartedAtMilliseconds = 0;
	private drainKillStarted = false;
	private stopping = false;
	private sigtermRequested = false;
	private readonly servedDispatchIds = new Set<string>();
	private entriesAwaitingPublish: readonly OverlayEntryReference[] = [];
	private entriesAwaitingClear: readonly OverlayEntryReference[] = [];
	private nextClearAttemptAtMilliseconds = 0;
	private clearInFlight: Promise<boolean> | null = null;
	private readonly files: LiveFileOperations;

	/**
	 * The credentials of the turn being served, as the supervisor holds and renews them. The socket server reads them for the
	 * child; it answers nothing for any dispatch but the one being served.
	 */
	readonly turnCredentials: TurnCredentialSource = { current: (dispatchId) => this.turnLease?.current(dispatchId) ?? null };

	/** Whether a per-turn child is running: the socket serves no one while it is not. */
	get servingTurn(): boolean {
		return this.turnLease !== null;
	}

	constructor(options: OwnerSupervisorOptions) {
		this.options = options;
		this.identity = options.identity;
		this.files = new LiveFileOperations({
			launcher: options.fileHelperLauncher,
			postResult: (operationId, outcome) => this.postFileResult(operationId, outcome),
			clock: options.clock,
			log: options.log,
			workspaceRoot: options.workspaceRoot,
			memoryUsedPercent: () => options.memoryUsedPercent?.(),
			onFinished: (kind, outcome) => this.onFileOperationFinished(kind, outcome),
		});
	}

	/** Where the supervisor is in its life, as it reports it with the next poll. */
	get state(): OwnerState {
		return this.currentState;
	}

	/**
	 * Tell the supervisor the container is being stopped. It stops accepting dispatches, ends the child, publishes the disk if
	 * it changed, reports the computer stopped for its generation and ends with exit code 143. No stop is requested: the
	 * platform stops the task regardless.
	 */
	requestTermination(): void {
		this.sigtermRequested = true;
		this.wake();
	}

	/**
	 * Run the supervisor from its first log line to the end of its life.
	 *
	 * @returns The process exit code: 0 stopped in good order, 4 fenced, 5 no longer the owner, 6 bootstrap failed, 8 the disk could not be restored, 9 still stopping when its credentials were about to end, 143 stopped by SIGTERM.
	 */
	async run(): Promise<number> {
		this.log("owner_started", { generation: this.identity.generation, pid: process.pid });
		this.startedAtMilliseconds = this.now();
		if (!(await this.bootstrap())) return this.exitCode ?? SUPERVISOR_EXIT_BOOTSTRAP_FAILED;
		while (this.exitCode === undefined) {
			await this.waitForNextEvent();
			if (this.exitCode !== undefined) break;
			await this.doDueWork();
			if (this.exitCode !== undefined) break;
			if (this.now() >= this.nextPollAtMilliseconds) await this.pollOnce();
			this.fenceIfSilent();
		}
		return this.exitCode;
	}

	private now(): number {
		return this.options.clock.nowMilliseconds();
	}

	private log(event: string, fields: Parameters<LogEmitter>[1] = {}): void {
		this.options.log(event, fields);
	}

	private finish(code: number): void {
		if (this.exitCode !== undefined) return;
		this.exitCode = code;
		this.wake();
	}

	private wake(): void {
		this.wakeRequested = true;
		this.wakeController?.abort();
	}

	private requestPollNow(): void {
		this.nextPollAtMilliseconds = this.now();
		this.wake();
	}

	private async bootstrap(): Promise<boolean> {
		const startedAt = this.now();
		let attempts = 0;
		for (;;) {
			if (this.sigtermRequested) {
				this.log("owner_stopping", { reason: "sigterm", uptime_ms: this.now() - this.startedAtMilliseconds, turns_served: 0 });
				this.finish(SUPERVISOR_EXIT_SIGTERM);
				return false;
			}
			attempts += 1;
			try {
				const response = await this.options.plane.bootstrap({
					owner_id: this.identity.ownerId,
					generation: this.identity.generation,
					protocol_version: OWNER_PROTOCOL_VERSION,
				});
				const expiresAt = Math.min(Date.parse(response.aws_credentials.expires_at), Date.parse(response.supervisor_token_expires_at));
				const holder = new CredentialHolder(response.aws_credentials);
				this.awsCredentials = holder;
				this.supervisorLease = new CredentialLease(expiresAt, this.now());
				this.disk = this.options.openDisk(() => this.storageCredentials());
				this.log("owner_bootstrapped", { expires_at: new Date(expiresAt).toISOString() });
				this.lastSuccessfulPollAtMilliseconds = this.now();
				this.nextPollAtMilliseconds = this.now();
				this.nextPollingLogAtMilliseconds = this.now() + POLLING_LOG_INTERVAL_MILLISECONDS;
				return true;
			} catch (error) {
				const refusal = error instanceof HostProtocolError ? error : null;
				const retriable = refusal === null || refusal.status >= 500;
				if (!retriable || this.now() - startedAt >= BOOTSTRAP_RETRY_WINDOW_MILLISECONDS) {
					this.log("owner_bootstrap_failed", { status: refusal?.status, code: refusal?.code, error_name: refusal === null ? errorNameOf(error) : undefined, attempts });
					this.finish(SUPERVISOR_EXIT_BOOTSTRAP_FAILED);
					return false;
				}
				await this.sleepUntilWoken(BOOTSTRAP_RETRY_PAUSE_MILLISECONDS);
				if (this.now() - startedAt >= BOOTSTRAP_RETRY_WINDOW_MILLISECONDS) {
					this.log("owner_bootstrap_failed", { status: refusal?.status, code: refusal?.code, error_name: refusal === null ? errorNameOf(error) : undefined, attempts });
					this.finish(SUPERVISOR_EXIT_BOOTSTRAP_FAILED);
					return false;
				}
			}
		}
	}

	private async sleepUntilWoken(milliseconds: number): Promise<void> {
		if (milliseconds <= 0 || this.wakeRequested) {
			this.wakeRequested = false;
			await new Promise<void>((resolve) => setImmediate(resolve));
			return;
		}
		const controller = new AbortController();
		this.wakeController = controller;
		await this.options.clock.sleep(milliseconds, controller.signal);
		this.wakeController = null;
		this.wakeRequested = false;
	}

	private async waitForNextEvent(): Promise<void> {
		const deadlines = [
			this.nextPollAtMilliseconds,
			this.lastSuccessfulPollAtMilliseconds + OWNER_POLL_SILENCE_FENCE_SECONDS * 1000,
			this.nextPollingLogAtMilliseconds,
		];
		const supervisorLease = this.supervisorLease;
		if (supervisorLease !== null) {
			deadlines.push(supervisorLease.hardDeadlineAtMilliseconds());
			if (!this.stopping && !this.draining) deadlines.push(supervisorLease.localDrainAtMilliseconds(), supervisorLease.dueAtMilliseconds());
		}
		if (!this.stopping && this.turnLease !== null) deadlines.push(this.turnLease.schedule.dueAtMilliseconds());
		if (this.canAskToStopForIdleness()) deadlines.push(Math.max(this.idleDeadline(), this.stopRetryAtMilliseconds));
		if (this.currentState === "idle" && this.idleStartedAtMilliseconds !== null) deadlines.push(this.nextIdleLogAtMilliseconds);
		if (this.canPublish() && this.nextPublishCheckAtMilliseconds !== null) deadlines.push(this.nextPublishCheckAtMilliseconds);
		if (!this.stopping && this.entriesAwaitingClear.length > 0 && this.clearInFlight === null) deadlines.push(this.nextClearAttemptAtMilliseconds);
		if (this.draining && this.child !== null && !this.drainKillStarted) deadlines.push(this.drainStartedAtMilliseconds + OWNER_DRAIN_GRACE_SECONDS * 1000);
		if (this.draining && this.child === null && this.activity === null && !this.stopping) deadlines.push(this.stopRetryAtMilliseconds);
		await this.sleepUntilWoken(Math.min(...deadlines) - this.now());
	}

	private idleDeadline(): number {
		return (this.idleStartedAtMilliseconds ?? Number.POSITIVE_INFINITY) + OWNER_IDLE_TIMEOUT_SECONDS * 1000;
	}

	private canAskToStopForIdleness(): boolean {
		return this.currentState === "idle" && this.idleStartedAtMilliseconds !== null && this.activity === null && !this.stopping && !this.draining;
	}

	private canPublish(): boolean {
		return this.currentState === "idle" && this.activity === null && !this.stopping && !this.draining && this.child === null && this.hydrated;
	}

	private async doDueWork(): Promise<void> {
		const now = this.now();
		if (this.supervisorLease !== null && now >= this.supervisorLease.hardDeadlineAtMilliseconds()) {
			this.endAtCredentialDeadline();
			return;
		}
		if (this.sigtermRequested && !this.stopping) {
			this.beginStop("sigterm");
			return;
		}
		if (now >= this.nextPollingLogAtMilliseconds) {
			this.log("owner_polling", {
				polls: this.pollsSinceLog,
				interval_ms: this.lastPollIntervalMilliseconds,
				dispatches: this.dispatchesSinceLog,
				failures: this.failuresSinceLog,
			});
			this.pollsSinceLog = 0;
			this.dispatchesSinceLog = 0;
			this.failuresSinceLog = 0;
			this.nextPollingLogAtMilliseconds = now + POLLING_LOG_INTERVAL_MILLISECONDS;
		}
		if (this.stopping) return;
		if (this.entriesAwaitingClear.length > 0 && this.clearInFlight === null && now >= this.nextClearAttemptAtMilliseconds) this.beginClear();
		this.startDueRenewals(now);
		this.beginCredentialDrainWhenExpiring(now);
		if (this.consecutiveChildFailures >= OWNER_CHILD_FAILURE_LIMIT && this.child === null && this.activity === null && now >= this.stopRetryAtMilliseconds) {
			await this.askToStop("unhealthy");
			return;
		}
		if (this.draining) {
			if (this.child !== null && !this.drainKillStarted && now >= this.drainStartedAtMilliseconds + OWNER_DRAIN_GRACE_SECONDS * 1000) {
				this.drainKillStarted = true;
				void this.terminateChild(TERMINATE_GRACE_AT_DRAIN_MILLISECONDS);
			}
			if (this.child === null && this.activity === null && now >= this.stopRetryAtMilliseconds) await this.askToStop(this.drainStopReason);
			return;
		}
		if (this.currentState !== "idle" || this.activity !== null || this.idleStartedAtMilliseconds === null) return;
		if (now >= this.nextIdleLogAtMilliseconds) {
			this.log("owner_idle", { idle_seconds: Math.floor((now - this.idleStartedAtMilliseconds) / 1000), timeout_seconds: OWNER_IDLE_TIMEOUT_SECONDS });
			this.nextIdleLogAtMilliseconds = now + IDLE_LOG_INTERVAL_MILLISECONDS;
		}
		if (this.nextPublishCheckAtMilliseconds !== null && now >= this.nextPublishCheckAtMilliseconds && this.canPublish()) {
			this.beginPublishCycle();
			return;
		}
		if (now >= this.idleDeadline() && now >= this.stopRetryAtMilliseconds) await this.askToStop("idle");
	}

	private async storageCredentials(): Promise<StorageCredentialIdentity> {
		const holder = this.awsCredentials;
		if (holder === null) throw new Error("the supervisor holds no storage credentials");
		const credentials = holder.current();
		const expiration = new Date(credentials.expires_at);
		if (expiration.getTime() <= this.now()) throw new Error("the supervisor's storage credentials have ended");
		return {
			accessKeyId: credentials.access_key_id,
			secretAccessKey: credentials.secret_access_key,
			sessionToken: credentials.session_token,
			expiration,
		};
	}

	private startDueRenewals(now: number): void {
		const supervisorLease = this.supervisorLease;
		if (supervisorLease !== null && !this.draining && supervisorLease.isDue(now)) this.startRenewal("supervisor", supervisorLease, null);
		const turn = this.turnLease;
		if (turn !== null && turn.schedule.isDue(now)) this.startRenewal("turn", turn.schedule, turn);
	}

	private startRenewal(kind: RenewalKind, schedule: CredentialLease, turn: TurnCredentialLease | null): void {
		const request: OwnerCredentialsRequest =
			turn === null
				? { kind: "supervisor", owner_id: this.identity.ownerId, generation: this.identity.generation }
				: { kind: "turn", owner_id: this.identity.ownerId, generation: this.identity.generation, dispatch_id: turn.dispatchId, turn_id: turn.turnId };
		const startedAtMilliseconds = this.now();
		const attempt: RenewalAttempt = {
			kind,
			schedule,
			turn,
			startedAtMilliseconds,
			attempts: schedule.consecutiveFailures + 1,
			remainingSecondsBefore: Math.floor(schedule.remainingMilliseconds(startedAtMilliseconds) / 1000),
		};
		schedule.beginRenewal();
		void this.runRenewal(request, attempt).finally(() => this.wake());
	}

	private async runRenewal(request: OwnerCredentialsRequest, attempt: RenewalAttempt): Promise<void> {
		try {
			const response = await this.options.plane.renewCredentials(request);
			this.onRenewalAnswered(response, attempt);
		} catch (error) {
			this.onRenewalFailed(error, attempt);
		}
	}

	private renewalIsMoot(attempt: RenewalAttempt): boolean {
		return this.stopping || this.exitCode !== undefined || (attempt.turn !== null && this.turnLease !== attempt.turn);
	}

	private onRenewalAnswered(response: OwnerCredentialsResponse, attempt: RenewalAttempt): void {
		if (this.renewalIsMoot(attempt)) {
			attempt.schedule.abandon();
			return;
		}
		const expiresAtMilliseconds = attempt.turn === null ? this.swapSupervisorCredentials(response, attempt.schedule) : this.swapTurnCredentials(response, attempt.turn);
		if (expiresAtMilliseconds === null) {
			this.onRenewalFailed(new RenewalMismatchError(), attempt);
			return;
		}
		attempt.schedule.succeeded(this.now(), expiresAtMilliseconds);
		this.log("owner_credentials_refreshed", {
			kind: attempt.kind,
			expires_at: new Date(expiresAtMilliseconds).toISOString(),
			attempts: attempt.attempts,
			duration_ms: this.now() - attempt.startedAtMilliseconds,
			remaining_seconds_before: attempt.remainingSecondsBefore,
		});
	}

	private swapSupervisorCredentials(response: OwnerCredentialsResponse, schedule: CredentialLease): number | null {
		const holder = this.awsCredentials;
		if (response.kind !== "supervisor" || holder === null) return null;
		const expiresAtMilliseconds = Math.min(Date.parse(response.aws_credentials.expires_at), Date.parse(response.supervisor_token_expires_at));
		if (!(expiresAtMilliseconds > schedule.expiresAt)) return null;
		holder.replace(response.aws_credentials);
		this.options.plane.replaceBearerToken(response.supervisor_token);
		return expiresAtMilliseconds;
	}

	private swapTurnCredentials(response: OwnerCredentialsResponse, turn: TurnCredentialLease): number | null {
		if (response.kind !== "turn" || response.dispatch_id !== turn.dispatchId || response.turn_id !== turn.turnId) return null;
		const expiresAtMilliseconds = Date.parse(response.expires_at);
		if (!(expiresAtMilliseconds > turn.schedule.expiresAt)) return null;
		turn.replace({ aws_credentials: response.aws_credentials, gateway_token: response.gateway_token, expires_at: response.expires_at });
		return expiresAtMilliseconds;
	}

	private onRenewalFailed(error: unknown, attempt: RenewalAttempt): void {
		const { kind, schedule, turn } = attempt;
		if (this.renewalIsMoot(attempt)) {
			schedule.abandon();
			return;
		}
		if (error instanceof HostProtocolError) {
			if (this.refusalEndsOwnership(error)) {
				schedule.abandon();
				this.endAsSuperseded();
				return;
			}
			const refusedForGood = error.status === 409 && (error.code === "owner_draining" || error.code === "owner_stopping" || (turn !== null && error.code === "turn_not_served"));
			if (refusedForGood) {
				schedule.refuse();
				if (turn !== null && error.code === "turn_not_served" && this.turnLease === turn) this.turnLease = null;
				this.log("owner_credentials_refresh_refused", { kind, code: error.code });
				return;
			}
		}
		schedule.failed(this.now());
		this.log("owner_credentials_refresh_failed", {
			kind,
			status: error instanceof HostProtocolError ? error.status : undefined,
			code: error instanceof HostProtocolError ? error.code : undefined,
			error_name: error instanceof HostProtocolError ? undefined : errorNameOf(error),
			consecutive_failures: schedule.consecutiveFailures,
			remaining_seconds: Math.floor(schedule.remainingMilliseconds(this.now()) / 1000),
		});
	}

	private beginCredentialDrainWhenExpiring(now: number): void {
		const lease = this.supervisorLease;
		if (lease === null || this.draining) return;
		const state = lease.state(now);
		if (state !== "expiring" && state !== "expired") return;
		this.log("owner_credentials_expiring", { remaining_seconds: Math.floor(lease.remainingMilliseconds(now) / 1000) });
		this.beginDrain("credentials", "credentials");
	}

	private endAtCredentialDeadline(): void {
		this.stopping = true;
		this.log("owner_stopping", { reason: "credentials_expired", uptime_ms: this.now() - this.startedAtMilliseconds, turns_served: this.turnsServed });
		this.child?.handle.kill("SIGKILL");
		this.finish(SUPERVISOR_EXIT_CREDENTIALS_EXPIRED);
	}

	private activeTurns(): OwnerPollRequest["active_turns"] {
		if (this.child === null || (this.currentState !== "serving" && this.currentState !== "draining")) return [];
		return [{ turn_id: this.child.turnId, dispatch_id: this.child.dispatchId }];
	}

	private async pollOnce(): Promise<void> {
		const memory = this.options.memoryUsedPercent?.();
		const request: OwnerPollRequest = {
			owner_id: this.identity.ownerId,
			generation: this.identity.generation,
			protocol_version: OWNER_PROTOCOL_VERSION,
			sequence: this.sequence,
			state: this.currentState,
			active_turns: this.activeTurns(),
			...(memory === undefined ? {} : { memory_used_percent: Math.max(0, Math.min(100, Math.round(memory))) }),
		};
		let response: OwnerPollResponse;
		try {
			response = await this.options.plane.poll(request);
		} catch (error) {
			this.onPollFailure(error);
			return;
		}
		this.consecutivePollFailures = 0;
		this.lastSuccessfulPollAtMilliseconds = this.now();
		this.sequence += 1;
		this.pollsSinceLog += 1;
		this.lastPollIntervalMilliseconds = response.next_poll_ms;
		this.nextPollAtMilliseconds = this.now() + response.next_poll_ms;
		this.onPollAnswered(response);
	}

	private onPollFailure(error: unknown): void {
		if (error instanceof HostProtocolError) {
			if (this.refusalEndsOwnership(error)) {
				if (!this.stopping) this.endAsSuperseded();
				return;
			}
			if (error.status === 409 && error.code === "stale_poll") {
				this.log("owner_poll_failed", { status: error.status, code: error.code, consecutive_failures: this.consecutivePollFailures, silent_seconds: this.silentSeconds() });
				this.sequence += 1;
				this.nextPollAtMilliseconds = this.now();
				return;
			}
		}
		this.consecutivePollFailures += 1;
		this.failuresSinceLog += 1;
		this.log("owner_poll_failed", {
			status: error instanceof HostProtocolError ? error.status : undefined,
			code: error instanceof HostProtocolError ? error.code : undefined,
			error_name: error instanceof HostProtocolError ? undefined : errorNameOf(error),
			consecutive_failures: this.consecutivePollFailures,
			silent_seconds: this.silentSeconds(),
		});
		const pause = POLL_FAILURE_PAUSES_MILLISECONDS[Math.min(this.consecutivePollFailures, POLL_FAILURE_PAUSES_MILLISECONDS.length) - 1]!;
		this.nextPollAtMilliseconds = this.now() + pause;
	}

	private silentSeconds(): number {
		return Math.floor((this.now() - this.lastSuccessfulPollAtMilliseconds) / 1000);
	}

	private refusalEndsOwnership(error: HostProtocolError): boolean {
		return refusalEndsOwnership(error);
	}

	private endAsSuperseded(): void {
		this.log("owner_stopping", { reason: "superseded", uptime_ms: this.now() - this.startedAtMilliseconds, turns_served: this.turnsServed });
		this.child?.handle.kill("SIGKILL");
		this.finish(SUPERVISOR_EXIT_SUPERSEDED);
	}

	private fenceIfSilent(): void {
		if (this.exitCode !== undefined) return;
		if (this.now() - this.lastSuccessfulPollAtMilliseconds < OWNER_POLL_SILENCE_FENCE_SECONDS * 1000) return;
		this.log("owner_stopping", { reason: "fenced", uptime_ms: this.now() - this.startedAtMilliseconds, turns_served: this.turnsServed });
		this.child?.handle.kill("SIGKILL");
		this.finish(SUPERVISOR_EXIT_FENCED);
	}

	private onPollAnswered(response: OwnerPollResponse): void {
		if (this.currentState === "booting") this.beginHydration();
		if (response.drain && !this.draining && !this.stopping) this.beginDrain(response.drain_reason ?? "unknown");
		const dispatch = response.dispatches[0];
		if (dispatch !== undefined) this.considerDispatch(dispatch);
		this.files.accept(response.file_requests, this.currentState === "hydrating" ? "owner_busy" : undefined);
	}

	private async postFileResult(operationId: string, outcome: LiveFileOutcome): Promise<"recorded" | "closed"> {
		try {
			await this.options.plane.postFileResult({ owner_id: this.identity.ownerId, generation: this.identity.generation, operation_id: operationId, outcome });
			return "recorded";
		} catch (error) {
			if (!(error instanceof HostProtocolError)) throw error;
			if (this.refusalEndsOwnership(error)) {
				this.endAsSuperseded();
				return "closed";
			}
			if (error.status >= 500) throw error;
			return "closed";
		}
	}

	private onFileOperationFinished(kind: string, outcome: LiveFileOutcome): void {
		if (this.currentState === "idle" && !this.stopping && !this.draining) this.startIdleClock();
		if (outcome.status === "ok" && (kind === "write" || kind === "delete" || kind === "move" || kind === "mkdir")) {
			const due = this.now() + OWNER_QUIET_PUBLISH_SECONDS * 1000;
			this.quietPublishDueAtMilliseconds = due;
			this.nextPublishCheckAtMilliseconds = this.nextPublishCheckAtMilliseconds === null ? due : Math.min(this.nextPublishCheckAtMilliseconds, due);
		}
		this.wake();
	}

	private beginHydration(): void {
		const disk = this.disk;
		if (disk === null) return;
		this.currentState = "hydrating";
		this.activity = (async () => {
			let applied: readonly OverlayEntryReference[];
			try {
				applied = await disk.hydrate();
			} catch (error) {
				if (error instanceof HostProtocolError && this.refusalEndsOwnership(error)) {
					this.endAsSuperseded();
					return;
				}
				this.log("snapshot_skipped", { reason: error instanceof OverlayApplyError ? "overlay_failed" : "boot_failed", error_name: errorNameOf(error) });
				this.finish(SUPERVISOR_EXIT_BOOT_FAILED);
				return;
			}
			this.hydrated = true;
			this.entriesAwaitingPublish = applied;
			const publishCheckSeconds = applied.length > 0 ? OVERLAY_EARLY_PUBLISH_SECONDS : OWNER_PERIODIC_PUBLISH_SECONDS;
			this.nextPublishCheckAtMilliseconds = this.now() + publishCheckSeconds * 1000;
			if (applied.length > 0) await this.clearAtOnceWhenDiskEqualsPublished(disk);
			this.activityEnded();
		})();
	}

	private async clearAtOnceWhenDiskEqualsPublished(disk: SupervisorDisk): Promise<void> {
		try {
			if (!(await disk.needsPublish())) this.promoteToAwaitingClear(this.entriesAwaitingPublish);
		} catch (error) {
			this.log("snapshot_check_failed", { error_name: errorNameOf(error) });
		}
	}

	private promoteToAwaitingClear(captured: readonly OverlayEntryReference[]): void {
		if (captured.length === 0) return;
		const same = (left: OverlayEntryReference, right: OverlayEntryReference): boolean => left.path === right.path && left.revision === right.revision;
		this.entriesAwaitingPublish = this.entriesAwaitingPublish.filter((entry) => !captured.some((candidate) => same(candidate, entry)));
		this.entriesAwaitingClear = [...this.entriesAwaitingClear, ...captured.filter((entry) => !this.entriesAwaitingClear.some((candidate) => same(candidate, entry)))];
		this.nextClearAttemptAtMilliseconds = this.now();
	}

	private beginClear(): void {
		this.clearInFlight = this.attemptClear().finally(() => {
			this.clearInFlight = null;
			this.wake();
		});
	}

	private async attemptClear(): Promise<boolean> {
		const disk = this.disk;
		const batch = this.entriesAwaitingClear;
		if (disk === null || batch.length === 0) return true;
		let acknowledged = false;
		try {
			acknowledged = await disk.clearApplied(batch);
		} catch (error) {
			if (error instanceof HostProtocolError && this.refusalEndsOwnership(error)) {
				this.endAsSuperseded();
				return false;
			}
			this.log("overlay_clear_failed", { error_name: errorNameOf(error) });
		}
		if (acknowledged) {
			this.entriesAwaitingClear = this.entriesAwaitingClear.filter((entry) => !batch.some((cleared) => cleared.path === entry.path && cleared.revision === entry.revision));
		} else {
			this.nextClearAttemptAtMilliseconds = this.now() + OVERLAY_CLEAR_RETRY_SECONDS * 1000;
		}
		return acknowledged;
	}

	private async clearBeforeStoppedReport(): Promise<void> {
		await this.clearInFlight;
		for (let attempt = 1; attempt <= CLEAR_ATTEMPTS_BEFORE_STOPPED_REPORT && this.entriesAwaitingClear.length > 0 && this.exitCode === undefined; attempt += 1) {
			if (await this.attemptClear()) return;
			if (attempt < CLEAR_ATTEMPTS_BEFORE_STOPPED_REPORT) await this.options.clock.sleep(CLEAR_ATTEMPT_PAUSE_MILLISECONDS);
		}
	}

	private activityEnded(): void {
		this.activity = null;
		if (!this.draining && !this.stopping && this.currentState !== "serving") {
			this.currentState = "idle";
			if (this.idleStartedAtMilliseconds === null) this.startIdleClock();
		}
		this.wake();
	}

	private startIdleClock(): void {
		this.idleStartedAtMilliseconds = this.now();
		this.nextIdleLogAtMilliseconds = this.now() + IDLE_LOG_INTERVAL_MILLISECONDS;
		this.log("owner_idle", { idle_seconds: 0, timeout_seconds: OWNER_IDLE_TIMEOUT_SECONDS });
	}

	private beginPublishCycle(): void {
		const disk = this.disk;
		if (disk === null) return;
		this.currentState = "publishing";
		this.quietPublishDueAtMilliseconds = null;
		const captured = this.entriesAwaitingPublish;
		this.activity = (async () => {
			try {
				if (await disk.needsPublish()) await disk.publish();
				this.promoteToAwaitingClear(captured);
			} catch (error) {
				this.log("snapshot_check_failed", { error_name: errorNameOf(error) });
			}
			const periodic = this.now() + OWNER_PERIODIC_PUBLISH_SECONDS * 1000;
			this.nextPublishCheckAtMilliseconds = this.quietPublishDueAtMilliseconds === null ? periodic : Math.min(periodic, this.quietPublishDueAtMilliseconds);
			this.activityEnded();
		})();
	}

	private beginDrain(reason: string, stopReason: "lifetime" | "credentials" = "lifetime"): void {
		this.draining = true;
		this.drainStopReason = stopReason;
		this.drainStartedAtMilliseconds = this.now();
		if (this.currentState !== "hydrating" && this.currentState !== "publishing") this.currentState = "draining";
		this.log("owner_draining", { reason });
		this.wake();
	}

	private considerDispatch(dispatch: OwnerDispatch): void {
		this.dispatchesSinceLog += 1;
		const ignore = (reason: string): void => {
			this.log("owner_dispatch_ignored", { dispatch_id: dispatch.dispatch_id, turn_id: dispatch.turn_id, reason });
		};
		if (this.draining || this.stopping) return ignore("not_accepting");
		if (this.child !== null || this.currentState !== "idle") return ignore("busy");
		if (this.servedDispatchIds.has(dispatch.dispatch_id)) return ignore("already_served");
		this.startChild(dispatch);
	}

	private startChild(dispatch: OwnerDispatch): void {
		this.log("owner_dispatch_received", { dispatch_id: dispatch.dispatch_id, turn_id: dispatch.turn_id, bot_id: dispatch.bot_id, attempt: dispatch.attempt });
		this.servedDispatchIds.add(dispatch.dispatch_id);
		let handle: SpawnedChild;
		try {
			handle = this.options.spawner.spawn("turn", buildOwnerChildEnvironment(this.options.environment, dispatch));
		} catch (error) {
			this.consecutiveChildFailures += 1;
			this.log("owner_child_spawn_failed", { dispatch_id: dispatch.dispatch_id, turn_id: dispatch.turn_id, error_name: errorNameOf(error), consecutive_failures: this.consecutiveChildFailures });
			return;
		}
		const child: RunningChild = {
			handle,
			dispatchId: dispatch.dispatch_id,
			turnId: dispatch.turn_id,
			botId: dispatch.bot_id,
			startedAtMilliseconds: this.now(),
		};
		this.child = child;
		this.turnLease = new TurnCredentialLease(
			dispatch.dispatch_id,
			dispatch.turn_id,
			{ aws_credentials: dispatch.aws_credentials, gateway_token: dispatch.gateway_token, expires_at: dispatch.expires_at },
			this.now(),
		);
		this.currentState = "serving";
		this.idleStartedAtMilliseconds = null;
		const waitingSince = dispatch.waiting_since === null ? null : Date.parse(dispatch.waiting_since);
		this.log("owner_serving_turn", {
			dispatch_id: dispatch.dispatch_id,
			turn_id: dispatch.turn_id,
			bot_id: dispatch.bot_id,
			queue_wait_ms: waitingSince === null ? null : Math.max(0, this.now() - waitingSince),
			concurrent: 1,
		});
		void handle.exited.then((exit) => this.onChildExit(child, exit));
		this.requestPollNow();
	}

	private async onChildExit(child: RunningChild, exit: ChildExit): Promise<void> {
		if (this.turnLease?.dispatchId === child.dispatchId) this.turnLease = null;
		const failed = !(exit.code === 0 || exit.code === 1);
		this.consecutiveChildFailures = failed ? this.consecutiveChildFailures + 1 : 0;
		await this.files.pause();
		try {
			await this.options.sweeper.sweep();
		} catch (error) {
			this.log("owner_sweep_failed", { error_name: errorNameOf(error) });
		} finally {
			this.files.resume();
		}
		this.log("owner_child_exited", {
			dispatch_id: child.dispatchId,
			turn_id: child.turnId,
			code: exit.code,
			signal: exit.signal,
			duration_ms: this.now() - child.startedAtMilliseconds,
			clean: exit.code === 0 && exit.signal === null,
			consecutive_failures: this.consecutiveChildFailures,
		});
		this.turnsServed += 1;
		this.child = null;
		if (!this.draining && !this.stopping) {
			this.currentState = this.activity === null ? "idle" : this.currentState;
			this.startIdleClock();
			this.nextPublishCheckAtMilliseconds = this.now() + OWNER_QUIET_PUBLISH_SECONDS * 1000;
		} else if (this.draining && !this.stopping) {
			this.currentState = "draining";
		}
		this.requestPollNow();
	}

	private async terminateChild(graceMilliseconds: number): Promise<void> {
		const child = this.child;
		if (child === null) return;
		child.handle.kill("SIGTERM");
		const cancel = new AbortController();
		const outcome = await Promise.race([child.handle.exited.then(() => "exited" as const), this.options.clock.sleep(graceMilliseconds, cancel.signal).then(() => "grace_over" as const)]);
		cancel.abort();
		if (outcome === "grace_over") {
			child.handle.kill("SIGKILL");
			await child.handle.exited;
		}
	}

	private async askToStop(reason: Exclude<StopCause, "sigterm">): Promise<void> {
		this.log("owner_stop_requested", { reason });
		try {
			const answer = await this.options.plane.stopRequest({
				owner_id: this.identity.ownerId,
				generation: this.identity.generation,
				reason,
				active_turns: this.activeTurns(),
			});
			if (answer.approved) {
				this.beginStop(reason);
				return;
			}
			this.log("owner_stop_vetoed", { reason: answer.reason });
		} catch (error) {
			if (error instanceof HostProtocolError && this.refusalEndsOwnership(error)) {
				this.endAsSuperseded();
				return;
			}
			this.log("owner_stop_request_failed", { reason, error_name: error instanceof HostProtocolError ? undefined : errorNameOf(error), status: error instanceof HostProtocolError ? error.status : undefined });
		}
		this.stopRetryAtMilliseconds = this.now() + OWNER_STOP_RETRY_SECONDS * 1000;
	}

	private beginStop(cause: StopCause): void {
		if (this.stopping) return;
		this.stopping = true;
		this.currentState = "stopping";
		this.performStop(cause).catch((error) => {
			this.log("owner_stop_failed", { reason: cause, error_name: errorNameOf(error) });
			this.finish(cause === "sigterm" ? SUPERVISOR_EXIT_SIGTERM : SUPERVISOR_EXIT_STOPPED);
		});
	}

	private async performStop(cause: StopCause): Promise<void> {
		this.log("owner_stopping", { reason: cause, uptime_ms: this.now() - this.startedAtMilliseconds, turns_served: this.turnsServed });
		this.requestPollNow();
		await this.files.stopAccepting();
		await this.terminateChild(cause === "sigterm" ? TERMINATE_GRACE_AT_SIGTERM_MILLISECONDS : TERMINATE_GRACE_AT_DRAIN_MILLISECONDS);
		try {
			await this.options.sweeper.sweep();
		} catch (error) {
			this.log("owner_sweep_failed", { error_name: errorNameOf(error) });
		}
		await this.activity;
		if (this.exitCode !== undefined) return;
		const disk = this.disk;
		if (disk !== null && this.hydrated) {
			const captured = this.entriesAwaitingPublish;
			try {
				if (await disk.needsPublish()) await disk.publish();
				this.promoteToAwaitingClear(captured);
			} catch (error) {
				this.log("snapshot_check_failed", { error_name: errorNameOf(error) });
			}
			await this.clearBeforeStoppedReport();
			if (this.exitCode !== undefined) return;
		}
		for (let attempt = 1; attempt <= STOPPED_REPORT_ATTEMPTS; attempt += 1) {
			try {
				await this.options.plane.setComputerStopped(true, this.identity.generation);
				break;
			} catch (error) {
				if (error instanceof HostProtocolError && this.refusalEndsOwnership(error)) {
					this.endAsSuperseded();
					return;
				}
				this.log("owner_stopped_report_failed", { attempt, error_name: error instanceof HostProtocolError ? undefined : errorNameOf(error), status: error instanceof HostProtocolError ? error.status : undefined });
				if (attempt < STOPPED_REPORT_ATTEMPTS) await this.options.clock.sleep(STOPPED_REPORT_PAUSE_MILLISECONDS);
			}
		}
		this.finish(cause === "sigterm" ? SUPERVISOR_EXIT_SIGTERM : SUPERVISOR_EXIT_STOPPED);
	}
}
