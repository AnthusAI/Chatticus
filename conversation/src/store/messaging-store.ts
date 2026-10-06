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
}
