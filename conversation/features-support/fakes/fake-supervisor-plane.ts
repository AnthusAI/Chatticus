import type { HostComputer } from "@chatticus/host-protocol";
import type {
	OwnerBootstrapRequest,
	OwnerBootstrapResponse,
	OwnerDispatch,
	OwnerErrorCode,
	OwnerPollRequest,
	OwnerPollResponse,
	OwnerStopReason,
	OwnerStopRequest,
	OwnerStopResponse,
	OwnerStopVetoReason,
} from "@chatticus/host-protocol/supervisor";
import { HostProtocolError } from "../../../computer/host/src/protocol-client.ts";
import type { SupervisorClock, SupervisorPlane } from "../../../computer/host/src/supervisor-ports.ts";

/** The secret values the fake control plane issues, so a scenario can search the logs for them. */
export const FAKE_SUPERVISOR_SECRETS = {
	supervisorToken: "scenario-supervisor-token-value",
	supervisorAccessKeyId: "scenario-supervisor-key-id",
	supervisorSecretAccessKey: "scenario-supervisor-secret-value",
	supervisorSessionToken: "scenario-supervisor-session-value",
	gatewayToken: "scenario-gateway-token-value",
	turnAccessKeyId: "scenario-turn-key-id",
	turnSecretAccessKey: "scenario-turn-secret-value",
	turnSessionToken: "scenario-turn-session-value",
} as const;

/** One request the supervisor sent, with the fake time it arrived. */
export type Recorded<T> = { readonly request: T; readonly atMilliseconds: number };

/** What a scenario can ask of a dispatch the fake control plane offers. */
export type FakeDispatchSpec = {
	readonly turnId: string;
	readonly botId?: string;
	readonly dispatchId?: string;
	readonly userId?: string;
	readonly attempt?: number;
};

/** An HTTP refusal of an owner route as the supervisor's client throws it. */
export function ownerRouteRefusal(status: number, code: OwnerErrorCode): HostProtocolError {
	return new HostProtocolError(`refused with status ${status}`, status, code);
}

/** The answer of a poll that offers nothing and asks again in a second. */
export function emptyPollAnswer(nextPollMilliseconds: number = 1000): OwnerPollResponse {
	return { dispatches: [], file_requests: [], drain: false, next_poll_ms: nextPollMilliseconds };
}

/**
 * The Front Door as the supervisor sees it, scripted by a scenario. It answers the bootstrap, the poll, the stop request and
 * the computer routes, records every request with the fake time, and fails or holds them when a scenario says so.
 */
export class FakeSupervisorPlane implements SupervisorPlane {
	readonly bootstraps: Array<Recorded<OwnerBootstrapRequest>> = [];
	readonly polls: Array<Recorded<OwnerPollRequest>> = [];
	readonly stopRequests: Array<Recorded<OwnerStopRequest>> = [];
	readonly computerCalls: string[] = [];
	readonly stoppedReports: Array<{ readonly generation: number | undefined; readonly atMilliseconds: number }> = [];
	readonly pollFailures: Array<{ readonly sequence: number; readonly error: unknown }> = [];

	bootstrapScript: Array<Error | "ok"> = [];
	bootstrapRepeat: Error | "ok" = "ok";
	pollScript: Array<OwnerPollResponse | Error> = [];
	failEveryPoll: Error | null = null;
	sequenceToTimeOut: number | null = null;
	stopScript: OwnerStopResponse[] = [];
	vetoesByReason = new Map<OwnerStopReason, OwnerStopVetoReason>();
	pollAfterNextStopRequest: OwnerPollResponse | null = null;
	stoppedReportScript: Array<Error | "ok"> = [];
	heldRunningReport: { readonly promise: Promise<void>; release: () => void } | null = null;
	defaultNextPollMilliseconds = 1000;

	private readonly clock: SupervisorClock;
	private stopRequestedSincePoll = false;

	constructor(clock: SupervisorClock) {
		this.clock = clock;
	}

	/** Hold the report that the computer is running until {@link releaseHeldReport} is called. */
	holdRunningReport(): void {
		let release: () => void = () => undefined;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.heldRunningReport = { promise, release };
	}

	releaseHeldReport(): void {
		this.heldRunningReport?.release();
	}

	async bootstrap(request: OwnerBootstrapRequest): Promise<OwnerBootstrapResponse> {
		this.bootstraps.push({ request, atMilliseconds: this.clock.nowMilliseconds() });
		const outcome = this.bootstrapScript.shift() ?? this.bootstrapRepeat;
		if (outcome !== "ok") throw outcome;
		const expiresAt = new Date(this.clock.nowMilliseconds() + 3600_000).toISOString();
		return {
			computer_id: "household-computer",
			supervisor_token: FAKE_SUPERVISOR_SECRETS.supervisorToken,
			supervisor_token_expires_at: expiresAt,
			aws_credentials: {
				access_key_id: FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId,
				secret_access_key: FAKE_SUPERVISOR_SECRETS.supervisorSecretAccessKey,
				session_token: FAKE_SUPERVISOR_SECRETS.supervisorSessionToken,
				expires_at: expiresAt,
			},
		};
	}

	async poll(request: OwnerPollRequest): Promise<OwnerPollResponse> {
		this.polls.push({ request, atMilliseconds: this.clock.nowMilliseconds() });
		if (this.sequenceToTimeOut === request.sequence) {
			this.sequenceToTimeOut = null;
			const error = new DOMException("The operation timed out.", "TimeoutError");
			this.pollFailures.push({ sequence: request.sequence, error });
			throw error;
		}
		if (this.failEveryPoll !== null) {
			this.pollFailures.push({ sequence: request.sequence, error: this.failEveryPoll });
			throw this.failEveryPoll;
		}
		const scripted = this.pollScript.shift();
		if (scripted instanceof Error) {
			this.pollFailures.push({ sequence: request.sequence, error: scripted });
			throw scripted;
		}
		if (scripted !== undefined) return scripted;
		if (this.stopRequestedSincePoll && this.pollAfterNextStopRequest !== null) {
			const offered = this.pollAfterNextStopRequest;
			this.pollAfterNextStopRequest = null;
			this.stopRequestedSincePoll = false;
			return offered;
		}
		return emptyPollAnswer(this.defaultNextPollMilliseconds);
	}

	async stopRequest(request: OwnerStopRequest): Promise<OwnerStopResponse> {
		this.stopRequests.push({ request, atMilliseconds: this.clock.nowMilliseconds() });
		this.stopRequestedSincePoll = true;
		const scripted = this.stopScript.shift();
		if (scripted !== undefined) return scripted;
		const veto = this.vetoesByReason.get(request.reason);
		return veto === undefined ? { approved: true } : { approved: false, reason: veto };
	}

	async getComputer(): Promise<HostComputer> {
		this.computerCalls.push("get_computer");
		return {
			computer_id: "household-computer",
			tenant_id: "anthus",
			stopped: false,
			policy: "per_org",
			host_start_generation: 1,
			model_ready: true,
			workspace_ready: true,
			browser_ready: false,
			snapshot_generation: 0,
			disk_dirty: false,
			hydrate_required: false,
		};
	}

	async setComputerStopped(stopped: boolean, startGeneration?: number): Promise<HostComputer> {
		if (stopped) {
			this.stoppedReports.push({ generation: startGeneration, atMilliseconds: this.clock.nowMilliseconds() });
			const outcome = this.stoppedReportScript.shift() ?? "ok";
			if (outcome !== "ok") throw outcome;
			this.computerCalls.push(`stopped:true:${startGeneration ?? "none"}`);
		} else {
			if (this.heldRunningReport !== null) await this.heldRunningReport.promise;
			this.computerCalls.push("stopped:false");
		}
		return this.getComputer();
	}

	async recordComputerCapabilityReady(capability: string): Promise<HostComputer> {
		this.computerCalls.push(`ready:${capability}`);
		return this.getComputer();
	}

	async recordComputerCapabilityUnavailable(capability: string): Promise<HostComputer> {
		this.computerCalls.push(`unavailable:${capability}`);
		return this.getComputer();
	}

	async recordComputerHydrated(): Promise<void> {
		this.computerCalls.push("hydrated");
	}

	async publishComputerSnapshot(): Promise<void> {
		this.computerCalls.push("published");
	}
}

/**
 * A poll answer that offers one dispatch carrying the fake per-turn secrets.
 *
 * @param spec The turn and, optionally, the dispatch id, bot, member and attempt.
 * @param clock The clock the lease and expiry are measured from.
 */
export function dispatchPollAnswer(spec: FakeDispatchSpec, clock: SupervisorClock): OwnerPollResponse {
	const now = clock.nowMilliseconds();
	const dispatch: OwnerDispatch = {
		dispatch_id: spec.dispatchId ?? `dispatch-${spec.turnId}`,
		turn_id: spec.turnId,
		bot_id: spec.botId ?? "bot-1",
		channel_id: "channel-1",
		user_id: spec.userId ?? "ryan",
		action_id: `action-${spec.turnId}`,
		waiting_since: new Date(now - 2500).toISOString(),
		lease_expires_at: new Date(now + 30_000).toISOString(),
		attempt: spec.attempt ?? 1,
		gateway_token: FAKE_SUPERVISOR_SECRETS.gatewayToken,
		aws_credentials: {
			access_key_id: FAKE_SUPERVISOR_SECRETS.turnAccessKeyId,
			secret_access_key: FAKE_SUPERVISOR_SECRETS.turnSecretAccessKey,
			session_token: FAKE_SUPERVISOR_SECRETS.turnSessionToken,
			expires_at: new Date(now + 3600_000).toISOString(),
		},
		expires_at: new Date(now + 3600_000).toISOString(),
	};
	return { dispatches: [dispatch], file_requests: [], drain: false, next_poll_ms: 1000 };
}
