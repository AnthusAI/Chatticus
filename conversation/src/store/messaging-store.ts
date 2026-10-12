import type { Bot } from "./codecs/bot.ts";
import type { Task } from "./codecs/task.ts";
import type { Worker } from "./codecs/worker.ts";
import type { Computer } from "./codecs/computer.ts";
import type { Channel, ChannelMessageRecord } from "../domain/channels.ts";
import type { Identity, Organization, Membership, Invitation, OrganizationStatus } from "../domain/organizations.ts";

/** MessagingStore provides storage operations for organizations, identities, and memberships. */
export interface MessagingStore {
	getIdentityByEmail(email: string): Promise<Identity | null>;
	putIdentity(identity: Identity): Promise<void>;
	getOrganization(tenantId: string): Promise<Organization | null>;
	putOrganization(organization: Organization): Promise<void>;
	getMembership(tenantId: string, userId: string): Promise<Membership | null>;
	putMembership(membership: Membership): Promise<void>;
	listMemberships(tenantId: string): Promise<Membership[]>;
	getInvitation(invitationId: string): Promise<Invitation | null>;
	putInvitation(invitation: Invitation): Promise<void>;
	listOrganizationsForUser(userId: string): Promise<Organization[]>;
	listOrganizationsByStatus(status: OrganizationStatus): Promise<Organization[]>;
	/**
	 * Count one organization creation attempt for the user and return how many attempts, this one included,
	 * the user has made in the current window. The caller decides whether that count exceeds the limit.
	 */
	incrementOrganizationCreationAttempts(userId: string, now: Date, windowMilliseconds: number): Promise<number>;
	listPendingInvitationsForEmail(email: string): Promise<Invitation[]>;

	/**
	 * Persist one bot. With reserveName the organization-unique name is claimed in the same write, and a name
	 * already claimed throws DuplicateBotNameError.
	 */
	putBot(bot: Bot, reserveName: boolean): Promise<void>;
	getBot(tenantId: string, botId: string): Promise<Bot | null>;
	getBotByName(tenantId: string, name: string): Promise<Bot | null>;
	listBots(tenantId: string): Promise<Bot[]>;
	getBotIdempotency(tenantId: string, idempotencyKey: string): Promise<Bot | null>;
	putBotIdempotency(tenantId: string, idempotencyKey: string, bot: Bot): Promise<void>;
	putChannel(channel: Channel): Promise<void>;
	/** Persist a new canonical channel, or return the one already stored under its identifier. */
	putChannelIfAbsent(channel: Channel): Promise<Channel>;
	getChannel(tenantId: string, channelId: string): Promise<Channel | null>;
	listChannels(tenantId: string, userId: string): Promise<Channel[]>;
	/** The tenant that owns a channel identifier, or null when no tenant does. */
	resolveChannelTenant(channelId: string): Promise<string | null>;
	getChannelIdempotency(tenantId: string, idempotencyKey: string): Promise<Channel | null>;
	putChannelIdempotency(tenantId: string, idempotencyKey: string, channel: Channel): Promise<void>;
	/** The message and turn an earlier post with this Idempotency-Key created, or null. */
	getPostIdempotency(
		tenantId: string,
		idempotencyKey: string,
	): Promise<{ message: ChannelMessageRecord; turnId: string | null } | null>;
	/** Remember the message and turn one post created, so a retry with the same key replays them. */
	putPostIdempotency(
		tenantId: string,
		idempotencyKey: string,
		message: ChannelMessageRecord,
		turnId: string | null,
	): Promise<void>;
	/** Committed messages of one channel with a sequence greater than afterSeq. */
	listMessages(tenantId: string, channelId: string, afterSeq: number): Promise<ChannelMessageRecord[]>;
	/** Persist one committed channel message. */
	putMessage(message: ChannelMessageRecord): Promise<void>;
	putWorker(worker: Worker): Promise<void>;
	getWorker(tenantId: string, workerId: string): Promise<Worker | null>;
	listWorkers(tenantId: string): Promise<Worker[]>;
	putTask(task: Task): Promise<void>;
	getTask(tenantId: string, taskId: string): Promise<Task | null>;
	listTasks(tenantId: string, userId: string): Promise<Task[]>;
	getComputer(tenantId: string): Promise<Computer | null>;
	putComputer(computer: Computer): Promise<void>;
	/**
	 * Start the next host start generation under a lease, only while the stored generation is still `expectedGeneration`,
	 * so two callers that both saw no live lease cannot both start a host. A new generation also clears the disk write
	 * lock, because the host that held it belongs to the generation that wedged.
	 *
	 * @returns The computer after the change, or null when another caller moved the generation first.
	 */
	claimHostStartGeneration(tenantId: string, expectedGeneration: number, leaseExpiresAt: Date): Promise<Computer | null>;
	/**
	 * End the start lease of `generation`, only while it is still the stored generation, so the next start request claims
	 * a new generation at once instead of waiting for the lease to run out.
	 *
	 * @returns false when the stored generation is not `generation` (a newer owner holds the lease) or there is no computer.
	 */
	releaseHostStartLease(tenantId: string, generation: number): Promise<boolean>;
	/**
	 * Settle the record of a computer whose host is gone, only while the stored generation is still `expectedGeneration`
	 * and the record still claims a host (unpublished disk writes or a live-writer lock): mark it stopped with every
	 * readiness gate cleared, clear the dirty flag and the lock, set `hydrateRequired`, and record `hostLostAt` and
	 * `hostLostGeneration`.
	 *
	 * @returns The computer after the change, or null when the generation moved or the record claims no host.
	 */
	settleLostComputerHost(tenantId: string, expectedGeneration: number, lostAt: Date, hydrateRequired: boolean): Promise<Computer | null>;
	/**
	 * Record a published snapshot on the computer as a targeted update that touches no other field: the URI and checksum are set,
	 * the snapshot generation goes up by one and the dirty flag is cleared. A field written after the caller read the record
	 * (a dispatch, a stop approval, an interactive window) survives.
	 *
	 * @returns The computer after the change, or null when there is no computer or a hydrate is required first.
	 */
	recordComputerSnapshotPublished(tenantId: string, published: { snapshotUri: string; snapshotChecksum: string }): Promise<Computer | null>;
	/**
	 * Record that a host hydrated the published snapshot, as a targeted update: hydrate-required and dirty flags are cleared and
	 * the intended host is removed. No other field is touched.
	 *
	 * @returns The computer after the change, or null when there is no computer.
	 */
	recordComputerHydrated(tenantId: string): Promise<Computer | null>;
	/**
	 * Mark the live disk of the computer as holding writes no snapshot has published, without touching any other field.
	 *
	 * @returns false when the organization has no computer.
	 */
	markComputerDiskDirty(tenantId: string): Promise<boolean>;
	/**
	 * Grant the live disk write lock to `hostId` when nobody holds it or it already holds it.
	 *
	 * @returns false when another host holds the lock, or the organization has no computer.
	 */
	claimComputerDiskWriter(tenantId: string, hostId: string): Promise<boolean>;
	/**
	 * Record that the host start of `generation` was handed to the host driver, only while nothing dispatched it yet.
	 *
	 * @returns false when that generation was already dispatched or is no longer the current one.
	 */
	markHostStartDispatched(tenantId: string, generation: number): Promise<boolean>;
	/** Undo `markHostStartDispatched` for a generation whose driver call failed, so the next start may try again. */
	releaseHostStartDispatch(tenantId: string, generation: number): Promise<void>;
	/**
	 * Record the owner of a generation as the live owner, once. The condition is that the computer is still on the host
	 * start generation the bootstrap token names and no owner has used that generation or a later one. It clears the idle
	 * mark, the stop approval and every dispatch field, and never clears the last owner generation.
	 *
	 * @returns The computer after the change, or null when the generation moved or its bootstrap token was already used.
	 */
	consumeOwnerBootstrap(tenantId: string, bootstrap: OwnerBootstrapRecord): Promise<Computer | null>;
	/**
	 * Record one poll of an owner on its worker item: the heartbeat, the sequence and the state, only while the stored
	 * sequence is not newer than `sequence`. An equal sequence is a retry and proceeds.
	 *
	 * @returns false when a newer poll was already recorded (a delayed duplicate of an older poll), or the worker is missing.
	 */
	recordOwnerPoll(tenantId: string, workerId: string, poll: { sequence: number; state: string; at: Date }): Promise<boolean>;
	/**
	 * Change what the computer record says about the live owner, only while `ownerId` is still the owner: the protocol
	 * version it reported, and when it became idle (a date sets the mark, null removes it).
	 *
	 * @returns false when `ownerId` is not the live owner.
	 */
	updateOwnerPresence(tenantId: string, ownerId: string, change: { protocolVersion?: number; idleSinceAt?: Date | null }): Promise<boolean>;
	/**
	 * Store one dispatch for the live owner, only while the owner has no approved stop and the stored dispatch id is still
	 * `expectedDispatchId` (null: none is stored). An offer and a stop approval on the same record cannot both succeed.
	 *
	 * @returns false when the owner changed, a stop was approved, or another poll replaced the dispatch first.
	 */
	offerOwnerDispatch(tenantId: string, ownerId: string, expectedDispatchId: string | null, dispatch: OwnerDispatchRecord): Promise<boolean>;
	/**
	 * Approve the stop of the live owner, only while the stored dispatch id is still `expectedDispatchId` (null: none is
	 * stored), so a dispatch offered after the stop was judged defeats the approval.
	 *
	 * @returns false when the owner changed or the dispatch moved.
	 */
	approveOwnerStop(tenantId: string, ownerId: string, expectedDispatchId: string | null, approvedAt: Date): Promise<boolean>;
}

/** What the bootstrap exchange records about the owner. */
export type OwnerBootstrapRecord = {
	readonly ownerId: string;
	readonly generation: number;
	readonly protocolVersion: number;
	readonly startedAt: Date;
};

/** The dispatch the control plane offers to the owner, as the computer record stores it. */
export type OwnerDispatchRecord = {
	readonly dispatchId: string;
	readonly turnId: string;
	readonly actionId: string;
	readonly attempt: number;
	readonly leaseExpiresAt: Date;
};
