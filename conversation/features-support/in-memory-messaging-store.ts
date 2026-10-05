import type { Identity, Invitation, Membership, Organization, OrganizationStatus } from "../src/domain/organizations.ts";
import type { Channel, ChannelMessageRecord } from "../src/domain/channels.ts";
import type { Bot } from "../src/store/codecs/bot.ts";
import type { Computer } from "../src/store/codecs/computer.ts";
import { DuplicateBotNameError, OrganizationCreationRateLimitedError } from "../src/http/errors.ts";
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
		return Array.from(this.memberships.get(tenantId)?.values() ?? []);
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
		return result;
	}

	async listOrganizationsByStatus(status: OrganizationStatus): Promise<Organization[]> {
		return Array.from(this.organizations.values())
			.filter((organization) => organization.status === status)
			.sort((left, right) => (left.tenantId < right.tenantId ? -1 : left.tenantId > right.tenantId ? 1 : 0));
	}

	async recordOrganizationCreationAttempt(
		userId: string,
		now: Date,
		limit: number,
		windowMilliseconds: number,
	): Promise<void> {
		const cutoff = now.getTime() - windowMilliseconds;
		const attempts = (this.creationAttempts.get(userId) ?? []).filter((timestamp) => timestamp.getTime() > cutoff);
		attempts.push(now);
		this.creationAttempts.set(userId, attempts);
		if (attempts.length > limit) {
			throw new OrganizationCreationRateLimitedError(
				`User ${JSON.stringify(userId)} exceeded the organization creation rate limit of ${limit} attempts per 1:00:00.`,
			);
		}
	}

	async listPendingInvitationsForEmail(email: string): Promise<Invitation[]> {
		return Array.from(this.invitations.values()).filter(
			(invitation) => invitation.email === email && invitation.status === "pending",
		);
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
			.map((bot) => structuredClone(bot));
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
			.sort((left, right) => (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0));
	}

	async resolveChannelTenant(channelId: string): Promise<string | null> {
		for (const channel of this.channels.values()) {
			if (channel.channelId === channelId) {
				return channel.tenantId;
			}
		}
		return null;
	}

	async getChannelIdempotency(tenantId: string, idempotencyKey: string): Promise<Channel | null> {
		const channelId = this.channelIdempotency.get(`${tenantId}\u0000${idempotencyKey}`);
		return channelId === undefined ? null : this.getChannel(tenantId, channelId);
	}

	async putChannelIdempotency(tenantId: string, idempotencyKey: string, channel: Channel): Promise<void> {
		this.channelIdempotency.set(`${tenantId}\u0000${idempotencyKey}`, channel.channelId);
	}

	async listMessages(tenantId: string, channelId: string, afterSeq: number): Promise<ChannelMessageRecord[]> {
		return (this.messages.get(`${tenantId}\u0000${channelId}`) ?? [])
			.filter((message) => message.seq > afterSeq)
			.map((message) => structuredClone(message));
	}

	async getComputer(tenantId: string): Promise<Computer | null> {
		const computer = this.computers.get(tenantId);
		return computer === undefined ? null : structuredClone(computer);
	}

	async putComputer(computer: Computer): Promise<void> {
		this.computers.set(computer.tenantId, structuredClone(computer));
	}
}
