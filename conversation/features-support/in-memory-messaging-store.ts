import type { Identity, Invitation, Membership, Organization, OrganizationStatus } from "../src/domain/organizations.ts";
import type { Channel, ChannelMessageRecord } from "../src/domain/channels.ts";
import type { Bot } from "../src/store/codecs/bot.ts";
import type { Task } from "../src/store/codecs/task.ts";
import type { Worker } from "../src/store/codecs/worker.ts";
import type { Computer } from "../src/store/codecs/computer.ts";
import { DuplicateBotNameError } from "../src/http/errors.ts";
import type { MessagingStore } from "../src/store/messaging-store.ts";

/** In-memory messaging store for scenarios that do not need DynamoDB. */
export class InMemoryMessagingStore implements MessagingStore {
	private readonly identities = new Map<string, Identity>();
	private readonly organizations = new Map<string, Organization>();
	private readonly memberships = new Map<string, Map<string, Membership>>();
	private readonly invitations = new Map<string, Invitation>();
	private readonly creationAttempts = new Map<string, Date[]>();
	private readonly bots = new Map<string, Bot>();
	private readonly botIdsByName = new Map<string, string>();
	private readonly botIdempotency = new Map<string, string>();
	private readonly channels = new Map<string, Channel>();
	private readonly channelIdempotency = new Map<string, string>();
	private readonly messages = new Map<string, ChannelMessageRecord[]>();
	private readonly computers = new Map<string, Computer>();
	private readonly workers = new Map<string, Worker>();
	private readonly tasks = new Map<string, Task>();

	async getIdentityByEmail(email: string): Promise<Identity | null> {
		return this.identities.get(email) ?? null;
	}

	async putIdentity(identity: Identity): Promise<void> {
		this.identities.set(identity.email, identity);
	}

	async getOrganization(tenantId: string): Promise<Organization | null> {
		return this.organizations.get(tenantId) ?? null;
	}

	async putOrganization(organization: Organization): Promise<void> {
		this.organizations.set(organization.tenantId, organization);
	}

	async getMembership(tenantId: string, userId: string): Promise<Membership | null> {
		return this.memberships.get(tenantId)?.get(userId) ?? null;
	}

	async putMembership(membership: Membership): Promise<void> {
		let tenantMemberships = this.memberships.get(membership.tenantId);
		if (tenantMemberships === undefined) {
			tenantMemberships = new Map();
			this.memberships.set(membership.tenantId, tenantMemberships);
		}
		tenantMemberships.set(membership.userId, membership);
	}

	async listMemberships(tenantId: string): Promise<Membership[]> {
		return Array.from(this.memberships.get(tenantId)?.values() ?? []).sort((left, right) => compareStrings(left.userId, right.userId));
	}

	async getInvitation(invitationId: string): Promise<Invitation | null> {
		return this.invitations.get(invitationId) ?? null;
	}

	async putInvitation(invitation: Invitation): Promise<void> {
		this.invitations.set(invitation.invitationId, invitation);
	}

	async listOrganizationsForUser(userId: string): Promise<Organization[]> {
		const result: Organization[] = [];
		for (const organization of this.organizations.values()) {
			if (this.memberships.get(organization.tenantId)?.has(userId)) {
				result.push(organization);
			}
		}
		return result.sort((left, right) => compareStrings(left.tenantId, right.tenantId));
	}

	async listOrganizationsByStatus(status: OrganizationStatus): Promise<Organization[]> {
		return Array.from(this.organizations.values())
			.filter((organization) => organization.status === status)
			.sort((left, right) => compareStrings(left.tenantId, right.tenantId));
	}

	async incrementOrganizationCreationAttempts(userId: string, now: Date, windowMilliseconds: number): Promise<number> {
		const cutoff = now.getTime() - windowMilliseconds;
		const attempts = (this.creationAttempts.get(userId) ?? []).filter((timestamp) => timestamp.getTime() > cutoff);
		attempts.push(now);
		this.creationAttempts.set(userId, attempts);
		return attempts.length;
	}

	async listPendingInvitationsForEmail(email: string): Promise<Invitation[]> {
		return Array.from(this.invitations.values()).filter(
			(invitation) => invitation.email === email && invitation.status === "pending",
		).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
	}

	async putBot(bot: Bot, reserveName: boolean): Promise<void> {
		if (reserveName) {
			const nameKey = `${bot.tenantId}\u0000${bot.name}`;
			if (this.botIdsByName.has(nameKey)) {
				throw new DuplicateBotNameError(
					`Bot named '${bot.name}' already exists for tenant '${bot.tenantId}'.`,
				);
			}
			this.botIdsByName.set(nameKey, bot.botId);
		}
		this.bots.set(`${bot.tenantId}\u0000${bot.botId}`, structuredClone(bot));
	}

	async getBot(tenantId: string, botId: string): Promise<Bot | null> {
		const bot = this.bots.get(`${tenantId}\u0000${botId}`);
		return bot === undefined ? null : structuredClone(bot);
	}

	async getBotByName(tenantId: string, name: string): Promise<Bot | null> {
		const botId = this.botIdsByName.get(`${tenantId}\u0000${name}`);
		if (botId !== undefined) {
			return this.getBot(tenantId, botId);
		}
		for (const bot of this.bots.values()) {
			if (bot.tenantId === tenantId && bot.name === name) {
				return structuredClone(bot);
			}
		}
		return null;
	}

	async listBots(tenantId: string): Promise<Bot[]> {
		return Array.from(this.bots.values())
			.filter((bot) => bot.tenantId === tenantId)
			.map((bot) => structuredClone(bot))
			.sort((left, right) => compareStrings(left.name, right.name));
	}

	async getBotIdempotency(tenantId: string, idempotencyKey: string): Promise<Bot | null> {
		const botId = this.botIdempotency.get(`${tenantId}\u0000${idempotencyKey}`);
		return botId === undefined ? null : this.getBot(tenantId, botId);
	}

	async putBotIdempotency(tenantId: string, idempotencyKey: string, bot: Bot): Promise<void> {
		this.botIdempotency.set(`${tenantId}\u0000${idempotencyKey}`, bot.botId);
	}

	async putChannel(channel: Channel): Promise<void> {
		this.channels.set(`${channel.tenantId}\u0000${channel.channelId}`, structuredClone(channel));
	}

	async putChannelIfAbsent(channel: Channel): Promise<Channel> {
		const existing = this.channels.get(`${channel.tenantId}\u0000${channel.channelId}`);
		if (existing !== undefined) {
			return structuredClone(existing);
		}
		await this.putChannel(channel);
		return structuredClone(channel);
	}

	async getChannel(tenantId: string, channelId: string): Promise<Channel | null> {
		const channel = this.channels.get(`${tenantId}\u0000${channelId}`);
		return channel === undefined ? null : structuredClone(channel);
	}

	async listChannels(tenantId: string, userId: string): Promise<Channel[]> {
		return Array.from(this.channels.values())
			.filter(
				(channel) =>
					channel.tenantId === tenantId &&
					channel.participants.some((participant) => participant.kind === "human" && participant.actorId === userId),
			)
			.map((channel) => structuredClone(channel))
			.sort((left, right) => compareStrings(left.channelId, right.channelId));
	}

	async resolveChannelTenant(channelId: string): Promise<string | null> {
		for (const channel of this.channels.values()) {
			if (channel.channelId === channelId) {
				return channel.tenantId;
			}
		}
		return null;
	}

	private readonly postIdempotency = new Map<string, { message: ChannelMessageRecord; turnId: string | null }>();

	async getPostIdempotency(
		tenantId: string,
		idempotencyKey: string,
	): Promise<{ message: ChannelMessageRecord; turnId: string | null } | null> {
		return this.postIdempotency.get(`${tenantId}\u0000${idempotencyKey}`) ?? null;
	}

	async putPostIdempotency(
		tenantId: string,
		idempotencyKey: string,
		message: ChannelMessageRecord,
		turnId: string | null,
	): Promise<void> {
		this.postIdempotency.set(`${tenantId}\u0000${idempotencyKey}`, { message, turnId });
	}

	async getChannelIdempotency(tenantId: string, idempotencyKey: string): Promise<Channel | null> {
		const channelId = this.channelIdempotency.get(`${tenantId}\u0000${idempotencyKey}`);
		return channelId === undefined ? null : this.getChannel(tenantId, channelId);
	}

	async putChannelIdempotency(tenantId: string, idempotencyKey: string, channel: Channel): Promise<void> {
		this.channelIdempotency.set(`${tenantId}\u0000${idempotencyKey}`, channel.channelId);
	}

	async putMessage(message: ChannelMessageRecord): Promise<void> {
		const key = `${message.tenantId}\u0000${message.channelId}`;
		const kept = (this.messages.get(key) ?? []).filter((existing) => existing.seq !== message.seq);
		kept.push(structuredClone(message));
		this.messages.set(key, kept);
	}

	async listMessages(tenantId: string, channelId: string, afterSeq: number): Promise<ChannelMessageRecord[]> {
		return (this.messages.get(`${tenantId}\u0000${channelId}`) ?? [])
			.filter((message) => message.seq > afterSeq)
			.map((message) => structuredClone(message))
			.sort((left, right) => left.seq - right.seq);
	}

	async putWorker(worker: Worker): Promise<void> {
		this.workers.set(`${worker.tenantId}\u0000${worker.workerId}`, structuredClone(worker));
	}

	async getWorker(tenantId: string, workerId: string): Promise<Worker | null> {
		const worker = this.workers.get(`${tenantId}\u0000${workerId}`);
		return worker === undefined ? null : structuredClone(worker);
	}

	async listWorkers(tenantId: string): Promise<Worker[]> {
		return Array.from(this.workers.values())
			.filter((worker) => worker.tenantId === tenantId)
			.map((worker) => structuredClone(worker))
			.sort((left, right) => compareStrings(left.workerId, right.workerId));
	}

	async putTask(task: Task): Promise<void> {
		this.tasks.set(`${task.tenantId}\u0000${task.taskId}`, structuredClone(task));
	}

	async getTask(tenantId: string, taskId: string): Promise<Task | null> {
		const task = this.tasks.get(`${tenantId}\u0000${taskId}`);
		return task === undefined ? null : structuredClone(task);
	}

	async listTasks(tenantId: string, userId: string): Promise<Task[]> {
		return Array.from(this.tasks.values())
			.filter((task) => task.tenantId === tenantId && task.userId === userId)
			.map((task) => structuredClone(task))
			.sort((left, right) => compareStrings(left.taskId, right.taskId));
	}

	async getComputer(tenantId: string): Promise<Computer | null> {
		const computer = this.computers.get(tenantId);
		return computer === undefined ? null : structuredClone(computer);
	}

	async putComputer(computer: Computer): Promise<void> {
		this.computers.set(computer.tenantId, structuredClone(computer));
	}

	async claimHostStartGeneration(tenantId: string, expectedGeneration: number, leaseExpiresAt: Date): Promise<Computer | null> {
		const computer = this.computers.get(tenantId);
		if (computer === undefined || computer.hostStartGeneration !== expectedGeneration) {
			return null;
		}
		const { liveWriterHostId: _cleared, ...kept } = computer;
		const next = { ...kept, hostStartGeneration: expectedGeneration + 1, hostStartLeaseExpiresAt: leaseExpiresAt };
		this.computers.set(tenantId, next);
		return structuredClone(next);
	}

	async settleLostComputerHost(tenantId: string, expectedGeneration: number, lostAt: Date, hydrateRequired: boolean): Promise<Computer | null> {
		const computer = this.computers.get(tenantId);
		if (computer === undefined || computer.hostStartGeneration !== expectedGeneration) {
			return null;
		}
		if (!computer.diskDirty && computer.liveWriterHostId === undefined) {
			return null;
		}
		const { liveWriterHostId: _cleared, ...kept } = computer;
		const settled: Computer = {
			...kept,
			stopped: true,
			modelReady: false,
			workspaceReady: false,
			browserReady: false,
			diskDirty: false,
			hydrateRequired,
			hostLostAt: lostAt,
			hostLostGeneration: expectedGeneration,
		};
		this.computers.set(tenantId, settled);
		return structuredClone(settled);
	}

	async markComputerDiskDirty(tenantId: string): Promise<boolean> {
		const computer = this.computers.get(tenantId);
		if (computer === undefined) {
			return false;
		}
		this.computers.set(tenantId, { ...computer, diskDirty: true });
		return true;
	}

	async claimComputerDiskWriter(tenantId: string, hostId: string): Promise<boolean> {
		const computer = this.computers.get(tenantId);
		if (computer === undefined || (computer.liveWriterHostId !== undefined && computer.liveWriterHostId !== hostId)) {
			return false;
		}
		this.computers.set(tenantId, { ...computer, liveWriterHostId: hostId });
		return true;
	}

	async markHostStartDispatched(tenantId: string, generation: number): Promise<boolean> {
		const computer = this.computers.get(tenantId);
		if (
			computer === undefined ||
			computer.hostStartGeneration !== generation ||
			computer.hostStartDispatchedGeneration >= generation
		) {
			return false;
		}
		this.computers.set(tenantId, { ...computer, hostStartDispatchedGeneration: generation });
		return true;
	}

	async releaseHostStartDispatch(tenantId: string, generation: number): Promise<void> {
		const computer = this.computers.get(tenantId);
		if (computer !== undefined && computer.hostStartDispatchedGeneration === generation) {
			this.computers.set(tenantId, { ...computer, hostStartDispatchedGeneration: generation - 1 });
		}
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
