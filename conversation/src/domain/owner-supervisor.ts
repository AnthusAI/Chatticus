/**
 * What the control plane decides for the supervisor of a long-lived computer owner: the bootstrap exchange, the poll
 * that is also its heartbeat and its only way to receive a turn, and the request to stop.
 *
 * The owner asks; nothing connects to it. One owner serves the organization computer at a time, one dispatch is
 * outstanding at a time, and an approved stop and an offered dispatch can never both stand on the same record.
 * See docs/OWNER_SUPERVISOR_PROTOCOL.md sections 5 and 6.
 */

import {
	OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS,
	OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS,
	OWNER_DISPATCH_LEASE_SECONDS,
	OWNER_ERROR_STATUS,
	OWNER_HARD_LIFETIME_SECONDS,
	OWNER_ISSUANCE_CUTOFF_SECONDS,
	OWNER_MAX_LIFETIME_SECONDS,
	OWNER_MINIMUM_PROTOCOL_VERSION,
	OWNER_POLL_BUSY_MILLISECONDS,
	OWNER_POLL_FAST_MILLISECONDS,
	OWNER_POLL_FAST_WINDOW_SECONDS,
	OWNER_POLL_MEDIUM_MILLISECONDS,
	OWNER_POLL_MEDIUM_WINDOW_SECONDS,
	OWNER_POLL_SLOW_MILLISECONDS,
	OWNER_POLL_STARTING_MILLISECONDS,
	type OwnerBootstrapRequest,
	type OwnerBootstrapResponse,
	type OwnerBootstrapTokenClaims,
	type OwnerCredentialsRequest,
	type OwnerCredentialsResponse,
	type OwnerDispatch,
	type OwnerErrorCode,
	type OwnerPollRequest,
	type OwnerPollResponse,
	type OwnerState,
	type OwnerStopRequest,
	type OwnerStopResponse,
} from "@chatticus/host-protocol/supervisor";
import { OwnerCredentialBrokerError, type OwnerCredentialBrokerPort } from "../computer/owner-credential-broker.ts";
import type { Clock } from "../http/app.ts";
import { consoleLogEmitter, type LogEmitter } from "../observability/log-line.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { MessagingStore, OwnerCredentialsRenewal } from "../store/messaging-store.ts";
import { type ParkedWork, type ParkDependencies, actionDependenciesOf, computerWorkRefusal, parkedWork, resumeTurnForAction } from "../turn/park.ts";
import { expireLostComputerActions } from "./actions.ts";
import { denyOpenActionsOfTurn } from "./computer-start.ts";
import { deliverLiveFileRequests, ownerFilePanelPace, recordLiveFileResult } from "./live-files.ts";

/** A refusal of an owner route: the code the supervisor branches on and the status the code maps to. */
export class OwnerRefusal extends Error {
	readonly code: OwnerErrorCode;
	readonly status: (typeof OWNER_ERROR_STATUS)[OwnerErrorCode];

	/**
	 * @param code Why the route refused.
	 * @param detail A description that never carries a token or a claim.
	 */
	constructor(code: OwnerErrorCode, detail: string) {
		super(detail);
		this.name = "OwnerRefusal";
		this.code = code;
		this.status = OWNER_ERROR_STATUS[code];
	}
}

/** Who a verified supervisor token speaks for. The token itself is kept only to authorize the broker's per-turn grants. */
export type OwnerIdentity = {
	readonly tenantId: string;
	readonly computerId: string;
	readonly ownerId: string;
	readonly startGeneration: number;
	readonly token: string;
};

/** What the owner routes read and write. */
export type OwnerSupervisorDependencies = {
	readonly store: MessagingStore;
	readonly clock: Clock;
	readonly park: ParkDependencies;
	readonly broker: OwnerCredentialBrokerPort;
	/** The lowest protocol version served; an owner below it is told to drain. Defaults to OWNER_MINIMUM_PROTOCOL_VERSION. */
	readonly minimumProtocolVersion?: number;
};

/** Why the control plane tells an owner to drain, in the order the reasons are checked. */
export type OwnerDrainReason = "protocol_version" | "lifetime" | "credentials";

const STOP_JUDGMENT_ATTEMPTS = 3;

const dispatchWithheldLogged = new WeakMap<object, Set<string>>();

function dispatchWithheldOwnersOf(store: object): Set<string> {
	let owners = dispatchWithheldLogged.get(store);
	if (owners === undefined) {
		owners = new Set<string>();
		dispatchWithheldLogged.set(store, owners);
	}
	return owners;
}

const secondsBetween = (later: Date, earlier: Date): number => (later.getTime() - earlier.getTime()) / 1000;

const logOf = (identity: { tenantId: string; ownerId: string }): LogEmitter => consoleLogEmitter({ tenant_id: identity.tenantId, owner_id: identity.ownerId });

/**
 * Exchange a verified bootstrap token for the supervisor token and the supervisor's AWS credentials, once.
 *
 * The broker is asked first and the token is consumed second, in one conditional write of the computer record. A broker
 * that is unreachable leaves the token usable; a replay costs one STS call and delivers nothing.
 *
 * @param deps Stores, clock and the broker.
 * @param tenantId The organization of the request path.
 * @param claims The verified claims of the bootstrap token.
 * @param bootstrapToken The token the broker verifies again.
 * @param request The body of the request.
 * @returns The response of the exchange.
 * @throws OwnerRefusal With the code of the failed check.
 */
export async function exchangeOwnerBootstrap(
	deps: OwnerSupervisorDependencies,
	tenantId: string,
	claims: OwnerBootstrapTokenClaims,
	bootstrapToken: string,
	request: OwnerBootstrapRequest,
): Promise<OwnerBootstrapResponse> {
	const log = logOf({ tenantId, ownerId: claims.ownerId });
	const refuse = (code: OwnerErrorCode, detail: string): never => {
		log("owner_bootstrap_refused", { code });
		throw new OwnerRefusal(code, detail);
	};
	if (request.owner_id !== claims.ownerId || request.generation !== claims.startGeneration) {
		refuse("credential_mismatch", "bootstrap request does not match the bootstrap credential");
	}
	const computer = await deps.store.getComputer(tenantId);
	if (computer === null || computer.computerId !== claims.computerId || computer.hostStartGeneration !== claims.startGeneration) {
		refuse("stale_generation", "bootstrap credential is not valid for this host start generation");
	}
	const worker = await deps.store.getWorker(tenantId, claims.ownerId);
	if (worker === null || worker.computerId !== computer!.computerId) {
		refuse("owner_not_registered", "the owner is not registered for this computer");
	}
	let grant;
	try {
		grant = await deps.broker.issue({
			version: 1,
			purpose: "supervisor",
			tenant_id: tenantId,
			computer_id: claims.computerId,
			owner_id: claims.ownerId,
			generation: claims.startGeneration,
			authorization: bootstrapToken,
		});
	} catch (error) {
		if (!(error instanceof OwnerCredentialBrokerError)) throw error;
		return refuse("credentials_unavailable", "owner credentials are unavailable");
	}
	const now = deps.clock.now();
	const consumed = await deps.store.consumeOwnerBootstrap(tenantId, {
		ownerId: claims.ownerId,
		generation: claims.startGeneration,
		protocolVersion: request.protocol_version,
		startedAt: now,
		credentialsExpireAt: new Date(Math.min(Date.parse(grant.aws_credentials.expires_at), Date.parse(grant.supervisor_token_expires_at))),
	});
	if (consumed === null) {
		return refuse("bootstrap_already_used", "bootstrap credential was already used or its generation has moved on");
	}
	await deps.store.openComputerRuntimeSegment(tenantId, { ownerGeneration: claims.startGeneration, ownerId: claims.ownerId, startedAt: now });
	const { pollSequence: _sequence, pollState: _state, pollPaceMilliseconds: _pace, ...fresh } = worker!;
	await deps.store.putWorker({ ...fresh, lastHeartbeatAt: now });
	log("owner_bootstrap_ok", { generation: claims.startGeneration, protocol_version: request.protocol_version });
	return {
		computer_id: claims.computerId,
		supervisor_token: grant.supervisor_token,
		supervisor_token_expires_at: grant.supervisor_token_expires_at,
		aws_credentials: grant.aws_credentials,
	};
}

/**
 * The milliseconds the owner waits before its next poll: short while it boots, hydrates or publishes, busy-rate while it
 * serves, drains or stops, and for an idle owner longer the longer it has been idle.
 *
 * @param state What the owner reported.
 * @param idleSeconds Seconds since the owner became idle; only read in the idle state.
 * @returns The cadence.
 */
export function ownerPollCadence(state: OwnerState, idleSeconds: number): number {
	if (state === "booting" || state === "hydrating" || state === "publishing") return OWNER_POLL_STARTING_MILLISECONDS;
	if (state === "serving" || state === "draining" || state === "stopping") return OWNER_POLL_BUSY_MILLISECONDS;
	if (idleSeconds < OWNER_POLL_FAST_WINDOW_SECONDS) return OWNER_POLL_FAST_MILLISECONDS;
	if (idleSeconds < OWNER_POLL_MEDIUM_WINDOW_SECONDS) return OWNER_POLL_MEDIUM_MILLISECONDS;
	return OWNER_POLL_SLOW_MILLISECONDS;
}

/**
 * Why the control plane tells the owner to drain, or null when it does not. The drain is derived from what the control
 * plane issued: an owner drains when its protocol version is below the minimum, when it has served for its maximum
 * lifetime counted from its bootstrap exchange, or when the credentials it holds end within the drain budget. An owner
 * that never renews therefore drains that budget before its first credentials end, whatever lifetime the image assumes.
 * The server decides so the owner and the server never argue about two clocks.
 *
 * @param computer The computer record.
 * @param now The current time.
 * @param minimumProtocolVersion The lowest protocol version served.
 * @returns The reason, or null while the owner may go on.
 */
export function ownerDrainReason(computer: Computer, now: Date, minimumProtocolVersion: number): OwnerDrainReason | null {
	if (computer.ownerProtocolVersion !== undefined && computer.ownerProtocolVersion < minimumProtocolVersion) return "protocol_version";
	if (computer.ownerStartedAt !== undefined && secondsBetween(now, computer.ownerStartedAt) >= OWNER_MAX_LIFETIME_SECONDS) return "lifetime";
	if (computer.ownerCredentialsExpireAt !== undefined && secondsBetween(computer.ownerCredentialsExpireAt, now) <= OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS) return "credentials";
	return null;
}

/**
 * Whether the last stretch of the hard lifetime has begun, in which nothing is offered because the broker would refuse.
 *
 * @param computer The computer record.
 * @param now The current time.
 * @returns Whether the issuance cutoff has passed.
 */
export function ownerIssuanceClosed(computer: Computer, now: Date): boolean {
	return computer.ownerStartedAt !== undefined && secondsBetween(now, computer.ownerStartedAt) >= OWNER_ISSUANCE_CUTOFF_SECONDS;
}

function requireMatchingOwner(identity: OwnerIdentity, body: { owner_id: string; generation: number }): void {
	if (body.owner_id !== identity.ownerId || body.generation !== identity.startGeneration) {
		throw new OwnerRefusal("credential_mismatch", "request does not match the owner credential");
	}
}

const dispatchOf = (computer: Computer): { dispatchId: string; turnId: string; actionId: string; attempt: number; leaseExpiresAt: Date } | null =>
	computer.dispatchId === undefined ||
	computer.dispatchTurnId === undefined ||
	computer.dispatchActionId === undefined ||
	computer.dispatchAttempt === undefined ||
	computer.dispatchLeaseExpiresAt === undefined
		? null
		: {
				dispatchId: computer.dispatchId,
				turnId: computer.dispatchTurnId,
				actionId: computer.dispatchActionId,
				attempt: computer.dispatchAttempt,
				leaseExpiresAt: computer.dispatchLeaseExpiresAt,
			};

/**
 * Handle one poll of the owner: record the heartbeat, settle lost actions, decide the drain, offer at most one dispatch
 * and say how soon to ask again. The poll is idempotent: a retry with the same sequence is answered with the same
 * dispatch, and a delayed duplicate of an older poll is refused.
 *
 * @param deps Stores, clock and the broker.
 * @param identity The verified owner.
 * @param request The body of the poll.
 * @returns The answer.
 * @throws OwnerRefusal When the body names another owner or generation, or the poll is older than one already recorded.
 */
export async function pollOwner(deps: OwnerSupervisorDependencies, identity: OwnerIdentity, request: OwnerPollRequest): Promise<OwnerPollResponse> {
	requireMatchingOwner(identity, request);
	const now = deps.clock.now();
	const log = logOf(identity);
	const computerBeforePoll = await requireLiveComputer(deps.store, identity);
	const idleSecondsBeforePoll = computerBeforePoll.idleSinceAt === undefined ? 0 : secondsBetween(now, computerBeforePoll.idleSinceAt);
	const pace = ownerFilePanelPace(request.state, ownerPollCadence(request.state, idleSecondsBeforePoll), computerBeforePoll.interactiveUntilAt, now);
	if (!(await deps.store.recordOwnerPoll(identity.tenantId, identity.ownerId, { sequence: request.sequence, state: request.state, at: now, paceMilliseconds: pace }))) {
		throw new OwnerRefusal("stale_poll", "a newer poll of this owner was already recorded");
	}
	await deps.store.extendComputerRuntimeSegment(identity.tenantId, identity.startGeneration, now);
	if ((request.memory_used_percent ?? 0) >= 85) log("owner_memory_high", { memory_used_percent: request.memory_used_percent });
	let computer = await requireLiveComputer(deps.store, identity);
	const presence = presenceChange(computer, request, now);
	if (presence !== null) {
		await deps.store.updateOwnerPresence(identity.tenantId, identity.ownerId, presence);
		computer = (await deps.store.getComputer(identity.tenantId)) ?? computer;
	}
	for (const settled of await expireLostComputerActions(actionDependenciesOf(deps.park), identity.tenantId)) {
		if (settled.status === "done") await resumeTurnForAction(deps.park, settled.tenantId, settled.turnId, settled.actionId);
	}
	const drainReason = ownerDrainReason(computer, now, deps.minimumProtocolVersion ?? OWNER_MINIMUM_PROTOCOL_VERSION);
	const dispatches: OwnerDispatch[] = [];
	const issuanceClosed = ownerIssuanceClosed(computer, now);
	const mayDispatch = request.state === "idle" && request.active_turns.length === 0 && drainReason === null && computer.ownerStopApprovedAt === undefined;
	if (mayDispatch && !issuanceClosed) {
		const offered = await chooseDispatch(deps, identity, computer);
		if (offered !== null) dispatches.push(offered);
	}
	if (mayDispatch && issuanceClosed && !dispatchWithheldOwnersOf(deps.store).has(identity.ownerId)) {
		dispatchWithheldOwnersOf(deps.store).add(identity.ownerId);
		log("owner_dispatch_withheld", { reason: "issuance_cutoff" });
	}
	if (computer.ownerStartedAt !== undefined && secondsBetween(now, computer.ownerStartedAt) >= OWNER_HARD_LIFETIME_SECONDS) {
		log("owner_overdue", { age_seconds: Math.floor(secondsBetween(now, computer.ownerStartedAt)) });
	}
	return {
		dispatches,
		file_requests: await deliverLiveFileRequests(deps, identity, request, computer),
		drain: drainReason !== null,
		...(drainReason === null ? {} : { drain_reason: drainReason }),
		next_poll_ms: pace,
	};
}

async function requireLiveComputer(store: MessagingStore, identity: OwnerIdentity): Promise<Computer> {
	const computer = await store.getComputer(identity.tenantId);
	if (computer === null || computer.ownerId !== identity.ownerId) {
		throw new OwnerRefusal("not_current_owner", "owner credential is not valid for the current owner of this computer");
	}
	return computer;
}

function presenceChange(computer: Computer, request: OwnerPollRequest, now: Date): { protocolVersion?: number; idleSinceAt?: Date | null } | null {
	const change: { protocolVersion?: number; idleSinceAt?: Date | null } = {};
	if (computer.ownerProtocolVersion !== request.protocol_version) change.protocolVersion = request.protocol_version;
	if (request.state === "idle" && computer.idleSinceAt === undefined) change.idleSinceAt = now;
	if ((request.state === "serving" || request.state === "draining") && computer.idleSinceAt !== undefined) change.idleSinceAt = null;
	return Object.keys(change).length === 0 ? null : change;
}

async function chooseDispatch(deps: OwnerSupervisorDependencies, identity: OwnerIdentity, computer: Computer): Promise<OwnerDispatch | null> {
	const now = deps.clock.now();
	const log = logOf(identity);
	const current = dispatchOf(computer);
	const candidates = await parkedWork(deps.park, identity.tenantId);
	const stillParked =
		current === null ? undefined : candidates.find((work) => work.turn.turnId === current.turnId && work.action.actionId === current.actionId);
	if (current !== null && stillParked !== undefined && current.leaseExpiresAt.getTime() > now.getTime()) {
		const reoffered = await grantDispatch(deps, identity, stillParked, current);
		if (reoffered !== null) log("owner_dispatch_offered", { dispatch_id: current.dispatchId, turn_id: current.turnId, attempt: current.attempt, reoffer: true });
		return reoffered;
	}
	for (const work of candidates) {
		const refusal = await computerWorkRefusal(deps.park, identity.tenantId);
		if (refusal !== null) {
			await denyOpenActionsOfTurn(
				{
					actions: deps.park.computer.actions,
					clock: deps.clock,
					resumeTurn: async (tenantId, turnId, actionId) => {
						await resumeTurnForAction(deps.park, tenantId, turnId, actionId);
					},
				},
				identity.tenantId,
				work.turn.turnId,
				refusal,
			);
			continue;
		}
		if (work.turn.promptAuthorId === null) {
			log("owner_dispatch_skipped", { reason: "no_prompt_author", turn_id: work.turn.turnId });
			continue;
		}
		const sameAction = current !== null && current.actionId === work.action.actionId;
		const next = {
			dispatchId: `dispatch-${deps.park.turns.ids.next()}`,
			turnId: work.turn.turnId,
			actionId: work.action.actionId,
			attempt: sameAction ? current.attempt + 1 : 1,
			leaseExpiresAt: new Date(Math.floor(now.getTime() / 1000) * 1000 + OWNER_DISPATCH_LEASE_SECONDS * 1000),
		};
		const offered = await grantDispatch(deps, identity, work, next);
		if (offered === null) return null;
		if (!(await deps.store.offerOwnerDispatch(identity.tenantId, identity.ownerId, current?.dispatchId ?? null, next))) return null;
		log("owner_dispatch_offered", { dispatch_id: next.dispatchId, turn_id: next.turnId, attempt: next.attempt, reoffer: false });
		return offered;
	}
	return null;
}

async function grantDispatch(
	deps: OwnerSupervisorDependencies,
	identity: OwnerIdentity,
	work: ParkedWork,
	dispatch: { dispatchId: string; leaseExpiresAt: Date; attempt: number },
): Promise<OwnerDispatch | null> {
	const { turn, action } = work;
	if (turn.promptAuthorId === null) return null;
	try {
		const grant = await deps.broker.issue({
			version: 1,
			purpose: "turn",
			tenant_id: identity.tenantId,
			computer_id: identity.computerId,
			owner_id: identity.ownerId,
			generation: identity.startGeneration,
			authorization: identity.token,
			turn: { turn_id: turn.turnId, bot_id: turn.botId, channel_id: turn.channelId },
		});
		return {
			dispatch_id: dispatch.dispatchId,
			turn_id: turn.turnId,
			bot_id: turn.botId,
			channel_id: turn.channelId,
			user_id: turn.promptAuthorId,
			action_id: action.actionId,
			waiting_since: turn.waitingSince === null ? null : turn.waitingSince.toISOString(),
			lease_expires_at: dispatch.leaseExpiresAt.toISOString(),
			attempt: dispatch.attempt,
			gateway_token: grant.gateway_token,
			aws_credentials: grant.aws_credentials,
			expires_at: grant.expires_at,
		};
	} catch (error) {
		if (!(error instanceof OwnerCredentialBrokerError)) throw error;
		logOf(identity)("owner_dispatch_failed", { code: error.code });
		return null;
	}
}

/**
 * Renew the credentials of the live owner, its own or those of the turn it serves (docs/OWNER_CREDENTIAL_RENEWAL.md 6.2).
 *
 * The broker keeps reading no store, so this function is where the lifecycle is decided, in this order: the body names
 * the token's owner; the computer still names this owner; no stop was approved; for the supervisor kind the owner is not
 * draining and the issuance cutoff has not passed; for the turn kind the cutoff has not passed (a drain does not refuse)
 * and the dispatch and the turn are the ones this owner serves; the kind was not renewed within the minimum interval.
 * Only then is the broker asked. A broker that fails changes nothing, so the owner may ask again at once. A grant is
 * recorded in one conditional update; a grant that loses the race with an approved stop is discarded unseen.
 *
 * @param deps Stores, clock and the broker.
 * @param identity The verified owner, with the supervisor token that authorizes the broker.
 * @param request The body of the renewal request.
 * @returns The next credentials of the requested kind.
 * @throws OwnerRefusal With `credential_mismatch`, `not_current_owner`, `owner_stopping`, `owner_draining`, `turn_not_served`,
 * `renewal_too_soon` or `credentials_unavailable`.
 */
export async function renewOwnerCredentials(deps: OwnerSupervisorDependencies, identity: OwnerIdentity, request: OwnerCredentialsRequest): Promise<OwnerCredentialsResponse> {
	const log = logOf(identity);
	const refuse = (code: OwnerErrorCode, detail: string): never => {
		log("owner_credentials_refresh_refused", { kind: request.kind, code });
		throw new OwnerRefusal(code, detail);
	};
	if (request.owner_id !== identity.ownerId || request.generation !== identity.startGeneration) {
		refuse("credential_mismatch", "request does not match the owner credential");
	}
	const now = deps.clock.now();
	const computer = await deps.store.getComputer(identity.tenantId);
	if (computer === null || computer.ownerId !== identity.ownerId || computer.ownerGeneration !== identity.startGeneration) {
		return refuse("not_current_owner", "owner credential is not valid for the current owner of this computer");
	}
	if (computer.ownerStopApprovedAt !== undefined) return refuse("owner_stopping", "a stop of this owner was approved");
	if (ownerIssuanceClosed(computer, now)) return refuse("owner_draining", "the owner is in the last stretch of its lifetime");
	let served: { botId: string; channelId: string } | null = null;
	if (request.kind === "supervisor") {
		if (ownerDrainReason(computer, now, deps.minimumProtocolVersion ?? OWNER_MINIMUM_PROTOCOL_VERSION) !== null) {
			return refuse("owner_draining", "the control plane is draining this owner");
		}
	} else {
		served = await servedDispatchedTurn(deps, identity, computer, request, now);
		if (served === null) return refuse("turn_not_served", "the dispatch or the turn is not the one this owner serves");
	}
	const seenRenewedAt = (request.kind === "supervisor" ? computer.ownerCredentialsRenewedAt : computer.dispatchCredentialsRenewedAt) ?? null;
	if (seenRenewedAt !== null && secondsBetween(now, seenRenewedAt) < OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS) {
		return refuse("renewal_too_soon", "this kind of credentials was renewed less than a minute ago");
	}
	let granted: GrantedRenewal;
	try {
		granted = await grantRenewal(deps, identity, request, served, seenRenewedAt, now);
	} catch (error) {
		if (!(error instanceof OwnerCredentialBrokerError)) throw error;
		if (error.code === "owner_lifetime_over") return refuse("owner_draining", "the owner is in the last stretch of its lifetime");
		log("owner_credentials_refresh_failed", { kind: request.kind, code: error.code });
		throw new OwnerRefusal("credentials_unavailable", "owner credentials are unavailable");
	}
	if (!(await deps.store.renewOwnerCredentials(identity.tenantId, identity.ownerId, identity.startGeneration, granted.record))) {
		const after = await deps.store.getComputer(identity.tenantId);
		if (after === null || after.ownerId !== identity.ownerId || after.ownerGeneration !== identity.startGeneration) {
			return refuse("not_current_owner", "owner credential is not valid for the current owner of this computer");
		}
		if (after.ownerStopApprovedAt !== undefined) return refuse("owner_stopping", "a stop of this owner was approved");
		if (request.kind === "turn" && after.dispatchId !== request.dispatch_id) return refuse("turn_not_served", "the dispatch or the turn is not the one this owner serves");
		return refuse("renewal_too_soon", "this kind of credentials was renewed less than a minute ago");
	}
	log("owner_credentials_refresh_ok", {
		kind: request.kind,
		expires_at: granted.expiresAt,
		owner_age_seconds: computer.ownerStartedAt === undefined ? undefined : Math.floor(secondsBetween(now, computer.ownerStartedAt)),
	});
	return granted.response;
}

type GrantedRenewal = {
	readonly response: OwnerCredentialsResponse;
	readonly record: OwnerCredentialsRenewal;
	readonly expiresAt: string;
};

async function grantRenewal(
	deps: OwnerSupervisorDependencies,
	identity: OwnerIdentity,
	request: OwnerCredentialsRequest,
	served: { botId: string; channelId: string } | null,
	seenRenewedAt: Date | null,
	now: Date,
): Promise<GrantedRenewal> {
	const brokerBase = {
		version: 1 as const,
		tenant_id: identity.tenantId,
		computer_id: identity.computerId,
		owner_id: identity.ownerId,
		generation: identity.startGeneration,
		authorization: identity.token,
	};
	if (request.kind === "supervisor") {
		const grant = await deps.broker.issue({ ...brokerBase, purpose: "supervisor_renewal" });
		return {
			response: {
				kind: "supervisor",
				supervisor_token: grant.supervisor_token,
				supervisor_token_expires_at: grant.supervisor_token_expires_at,
				aws_credentials: grant.aws_credentials,
			},
			record: {
				kind: "supervisor",
				seenRenewedAt,
				renewedAt: now,
				credentialsExpireAt: new Date(Math.min(Date.parse(grant.aws_credentials.expires_at), Date.parse(grant.supervisor_token_expires_at))),
			},
			expiresAt: grant.supervisor_token_expires_at,
		};
	}
	const grant = await deps.broker.issue({ ...brokerBase, purpose: "turn", turn: { turn_id: request.turn_id, bot_id: served!.botId, channel_id: served!.channelId } });
	return {
		response: {
			kind: "turn",
			dispatch_id: request.dispatch_id,
			turn_id: request.turn_id,
			gateway_token: grant.gateway_token,
			aws_credentials: grant.aws_credentials,
			expires_at: grant.expires_at,
		},
		record: { kind: "turn", dispatchId: request.dispatch_id, seenRenewedAt, renewedAt: now },
		expiresAt: grant.expires_at,
	};
}

async function servedDispatchedTurn(
	deps: OwnerSupervisorDependencies,
	identity: OwnerIdentity,
	computer: Computer,
	request: { dispatch_id: string; turn_id: string },
	now: Date,
): Promise<{ botId: string; channelId: string } | null> {
	if (computer.dispatchId !== request.dispatch_id || computer.dispatchTurnId !== request.turn_id) return null;
	const turn = await deps.park.turns.store.getTurn(identity.tenantId, request.turn_id);
	if (turn === null || turn.status !== "active" || turn.claimedBy !== identity.ownerId) return null;
	if (turn.leaseExpiresAt === null || turn.leaseExpiresAt.getTime() <= now.getTime()) return null;
	return { botId: turn.botId, channelId: turn.channelId };
}

/**
 * Judge a stop request of the owner.
 *
 * `idle` is approved only when no work is pending and no turn is live; `lifetime` only after the control plane ordered the
 * drain, and then whatever is parked (the stopped report starts the next owner for it); `unhealthy` always. An approval is
 * one conditional write that fails if a dispatch was offered since the predicate was judged, so a veto cannot lose a
 * wake-up and an approved owner is never handed a turn.
 *
 * @param deps Stores, clock and the broker.
 * @param identity The verified owner.
 * @param request The body of the stop request.
 * @returns Approved, or the reason for the veto.
 * @throws OwnerRefusal When the body names another owner or generation, or the owner is not the live owner.
 */
export async function judgeOwnerStop(deps: OwnerSupervisorDependencies, identity: OwnerIdentity, request: OwnerStopRequest): Promise<OwnerStopResponse> {
	requireMatchingOwner(identity, request);
	const log = logOf(identity);
	for (let attempt = 0; attempt < STOP_JUDGMENT_ATTEMPTS; attempt += 1) {
		const now = deps.clock.now();
		const computer = await requireLiveComputer(deps.store, identity);
		const veto = await stopVeto(deps, identity, computer, request, now);
		if (veto !== null) {
			log("owner_stop_decision", { reason: request.reason, approved: false, veto });
			return { approved: false, reason: veto };
		}
		if (await deps.store.approveOwnerStop(identity.tenantId, identity.ownerId, computer.dispatchId ?? null, computer.fileOperationId ?? null, now)) {
			log("owner_stop_decision", { reason: request.reason, approved: true });
			return { approved: true };
		}
	}
	log("owner_stop_decision", { reason: request.reason, approved: false, veto: "dispatch_pending" });
	return { approved: false, reason: "dispatch_pending" };
}

async function stopVeto(
	deps: OwnerSupervisorDependencies,
	identity: OwnerIdentity,
	computer: Computer,
	request: OwnerStopRequest,
	now: Date,
): Promise<Extract<OwnerStopResponse, { approved: false }>["reason"] | null> {
	if (request.reason === "unhealthy" || request.reason === "credentials") return null;
	if (request.reason === "lifetime") return ownerDrainReason(computer, now, deps.minimumProtocolVersion ?? OWNER_MINIMUM_PROTOCOL_VERSION) === null ? "not_draining" : null;
	const pending = await parkedWork(deps.park, identity.tenantId);
	if (pending.length > 0) {
		const dispatched = pending.some(
			(work) =>
				work.turn.turnId === computer.dispatchTurnId &&
				work.action.actionId === computer.dispatchActionId &&
				computer.dispatchLeaseExpiresAt !== undefined &&
				computer.dispatchLeaseExpiresAt.getTime() > now.getTime(),
		);
		return dispatched ? "dispatch_pending" : "work_pending";
	}
	if ((await deps.store.countOpenLiveFileOperations(identity.tenantId, now)) > 0) return "file_operation_pending";
	if (request.active_turns.length > 0) return "turn_active";
	if (computer.dispatchTurnId !== undefined) {
		const turn = await deps.park.turns.store.getTurn(identity.tenantId, computer.dispatchTurnId);
		if (turn !== null && turn.status === "active" && turn.claimedBy === identity.ownerId && turn.leaseExpiresAt !== null && turn.leaseExpiresAt.getTime() > now.getTime()) {
			return "turn_active";
		}
	}
	return null;
}

/**
 * Record the owner's answer to one file request (docs/LIVE_FILES_PROTOCOL.md section 7.4).
 *
 * @param deps Stores and clock.
 * @param identity The verified owner.
 * @param request The body of the answer.
 * @throws OwnerRefusal With `credential_mismatch` when the body names another owner or generation, `operation_closed` when
 * the request is not this owner's delivered one, and `invalid_request` when the result is not the kind of the request.
 */
export async function recordOwnerFileResult(
	deps: OwnerSupervisorDependencies,
	identity: OwnerIdentity,
	request: { owner_id: string; generation: number; operation_id: string; outcome: Parameters<typeof recordLiveFileResult>[2]["outcome"] },
): Promise<{ recorded: true }> {
	requireMatchingOwner(identity, request);
	const decision = await recordLiveFileResult(deps, identity, request);
	if (decision.kind === "closed") throw new OwnerRefusal("operation_closed", "the file request is not open for this owner");
	if (decision.kind === "kind_mismatch") throw new OwnerRefusal("invalid_request", "the result is not the kind of the request");
	return { recorded: true };
}
