import { randomUUID } from "node:crypto";
import type { Clock } from "../storage/storage-support.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/** Lifecycle of one organization. */
export type OrganizationStatus = "pending" | "enabled" | "suspended";

/** Role of one member inside an organization. */
export type MemberRole = "owner" | "member";

/** Lifecycle of one organization invitation. */
export type InvitationStatus = "pending" | "accepted" | "expired";

/** AWS account setup path. */
export type AwsSetupPath = "customer-owned" | "anthus-managed";

/** One global human account keyed by verified email. */
export interface Identity {
	userId: string;
	email: string;
	createdAt: Date;
}

/** One organization; tenant_id is its identifier. */
export interface Organization {
	tenantId: string;
	name: string;
	status: OrganizationStatus;
	ownerUserId: string;
	createdAt: Date;
	awsAccountId: string | null;
	awsCrossAccountRole: string | null;
	awsExternalId: string | null;
	awsSetupPath: AwsSetupPath | null;
	monthlyAwsSpendCeilingUsd: number | null;
}

/** One user's membership in one organization. */
export interface Membership {
	tenantId: string;
	userId: string;
	role: MemberRole;
	joinedAt: Date;
}

/** One pending or accepted invitation to join an organization. */
export interface Invitation {
	invitationId: string;
	tenantId: string;
	email: string;
	invitedByUserId: string;
	role: MemberRole;
	status: InvitationStatus;
	expiresAt: Date;
	createdAt: Date;
}

/** The user id or email is unknown. */
export class IdentityNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdentityNotFoundError";
	}
}

/** An existing identity email maps to a different user_id than required. */
export class IdentityUserIdMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdentityUserIdMismatchError";
	}
}

/** Organization seed conflict when seeding. */
export class OrganizationSeedConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrganizationSeedConflictError";
	}
}

/** The organization id is unknown. */
export class OrganizationNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrganizationNotFoundError";
	}
}

/** The organization is not in enabled status. */
export class OrganizationNotEnabledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrganizationNotEnabledError";
	}
}

/** The organization cannot transition to the requested status. */
export class OrganizationStatusTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrganizationStatusTransitionError";
	}
}

/** The invitation id is unknown. */
export class InvitationNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvitationNotFoundError";
	}
}

/** The invitation email does not match the acceptor. */
export class InvitationEmailMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvitationEmailMismatchError";
	}
}

/** The invitation has expired. */
export class InvitationExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvitationExpiredError";
	}
}

/** The invitation is not in pending status. */
export class InvitationNotPendingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvitationNotPendingError";
	}
}

/** The user is not a member of the organization. */
export class MembershipNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MembershipNotFoundError";
	}
}

/** A user already belongs to the organization. */
export class DuplicateMembershipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DuplicateMembershipError";
	}
}

/** The user is not an owner of the organization. */
export class NotOrganizationOwnerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotOrganizationOwnerError";
	}
}

/** The last owner cannot be demoted. */
export class LastOwnerCannotBeDemotedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LastOwnerCannotBeDemotedError";
	}
}

/** Normalize a verified email for identity and invitation keys. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Organization records kernel for store-level scenarios. */
export interface OrganizationsKernel {
	signIn(email: string, deps: { store: MessagingStore; clock: Clock; ids: IdSource }): Promise<Identity>;
	createOrganization(
		owner: Identity,
		name: string,
		deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	): Promise<Organization>;
	enableOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization>;
	suspendOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization>;
	reinstateOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization>;
	setMemberRole(
		tenantId: string,
		actorUserId: string,
		memberUserId: string,
		role: MemberRole,
		deps: { store: MessagingStore },
	): Promise<Membership>;
	inviteByEmail(
		tenantId: string,
		inviterUserId: string,
		email: string,
		deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	): Promise<Invitation>;
	acceptInvitation(
		invitationId: string,
		acceptor: Identity,
		deps: { store: MessagingStore; clock: Clock },
	): Promise<Membership>;
	listOrganizationsForUser(userId: string, deps: { store: MessagingStore }): Promise<Organization[]>;
}

/** IdSource generates unique identifiers. */
export interface IdSource {
	next(): string;
}

/** Implementation of the organizations kernel. */
export class OrganizationsKernelImpl implements OrganizationsKernel {
	private invitationTtlDays: number = 7;

	async signIn(email: string, deps: { store: MessagingStore; clock: Clock; ids: IdSource }): Promise<Identity> {
		const normalized = normalizeEmail(email);
		const existing = await deps.store.getIdentityByEmail(normalized);
		if (existing !== null) {
			return existing;
		}
		const identity: Identity = {
			userId: deps.ids.next(),
			email: normalized,
			createdAt: deps.clock.now(),
		};
		await deps.store.putIdentity(identity);
		return identity;
	}

	async createOrganization(
		owner: Identity,
		name: string,
		deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	): Promise<Organization> {
		const tenantId = deps.ids.next();
		const now = deps.clock.now();
		const organization: Organization = {
			tenantId,
			name,
			status: "pending",
			ownerUserId: owner.userId,
			createdAt: now,
			awsAccountId: null,
			awsCrossAccountRole: null,
			awsExternalId: null,
			awsSetupPath: null,
			monthlyAwsSpendCeilingUsd: null,
		};
		await deps.store.putOrganization(organization);
		const membership: Membership = {
			tenantId,
			userId: owner.userId,
			role: "owner",
			joinedAt: now,
		};
		await deps.store.putMembership(membership);
		return organization;
	}

	async enableOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		if (organization.status !== "pending") {
			throw new OrganizationStatusTransitionError(
				`Organization ${JSON.stringify(tenantId)} has status ${JSON.stringify(organization.status)}; enable requires pending.`,
			);
		}
		const enabled: Organization = {
			...organization,
			status: "enabled",
		};
		await deps.store.putOrganization(enabled);
		return enabled;
	}

	async suspendOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		if (organization.status !== "enabled") {
			throw new OrganizationStatusTransitionError(
				`Organization ${JSON.stringify(tenantId)} has status ${JSON.stringify(organization.status)}; suspend requires enabled.`,
			);
		}
		const suspended: Organization = {
			...organization,
			status: "suspended",
		};
		await deps.store.putOrganization(suspended);
		return suspended;
	}

	async reinstateOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		if (organization.status !== "suspended") {
			throw new OrganizationStatusTransitionError(
				`Organization ${JSON.stringify(tenantId)} has status ${JSON.stringify(organization.status)}; reinstate requires suspended.`,
			);
		}
		const reinstated: Organization = {
			...organization,
			status: "enabled",
		};
		await deps.store.putOrganization(reinstated);
		return reinstated;
	}

	async setMemberRole(
		tenantId: string,
		actorUserId: string,
		memberUserId: string,
		role: MemberRole,
		deps: { store: MessagingStore },
	): Promise<Membership> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		const actor = await deps.store.getMembership(tenantId, actorUserId);
		if (actor === null || actor.role !== "owner") {
			throw new NotOrganizationOwnerError(
				`User ${JSON.stringify(actorUserId)} is not an owner of ${JSON.stringify(tenantId)}.`,
			);
		}
		const membership = await deps.store.getMembership(tenantId, memberUserId);
		if (membership === null) {
			throw new MembershipNotFoundError(
				`User ${JSON.stringify(memberUserId)} is not a member of ${JSON.stringify(tenantId)}.`,
			);
		}
		if (membership.role === "owner" && role !== "owner") {
			const otherOwners = await deps.store.listMemberships(tenantId);
			const hasOtherOwners = otherOwners.some(
				(item) => item.role === "owner" && item.userId !== memberUserId,
			);
			if (!hasOtherOwners) {
				throw new LastOwnerCannotBeDemotedError(
					`User ${JSON.stringify(memberUserId)} is the last owner of ${JSON.stringify(tenantId)}.`,
				);
			}
		}
		const updated: Membership = {
			...membership,
			role,
		};
		await deps.store.putMembership(updated);
		return updated;
	}

	async inviteByEmail(
		tenantId: string,
		inviterUserId: string,
		email: string,
		deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	): Promise<Invitation> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		const membership = await deps.store.getMembership(tenantId, inviterUserId);
		if (membership === null || membership.role !== "owner") {
			throw new NotOrganizationOwnerError(
				`User ${JSON.stringify(inviterUserId)} is not an owner of ${JSON.stringify(tenantId)}.`,
			);
		}
		const normalized = normalizeEmail(email);
		const now = deps.clock.now();
		const expiresAt = new Date(now.getTime() + this.invitationTtlDays * 24 * 60 * 60 * 1000);
		const invitation: Invitation = {
			invitationId: deps.ids.next(),
			tenantId,
			email: normalized,
			invitedByUserId: inviterUserId,
			role: "member",
			status: "pending",
			expiresAt,
			createdAt: now,
		};
		await deps.store.putInvitation(invitation);
		return invitation;
	}

	async acceptInvitation(
		invitationId: string,
		acceptor: Identity,
		deps: { store: MessagingStore; clock: Clock },
	): Promise<Membership> {
		const invitation = await deps.store.getInvitation(invitationId);
		if (invitation === null) {
			throw new InvitationNotFoundError(`Invitation ${JSON.stringify(invitationId)} is unknown.`);
		}
		if (invitation.status !== "pending") {
			throw new InvitationNotPendingError(`Invitation ${JSON.stringify(invitationId)} is not pending.`);
		}
		const now = deps.clock.now();
		if (invitation.expiresAt <= now) {
			throw new InvitationExpiredError(`Invitation ${JSON.stringify(invitationId)} has expired.`);
		}
		const organization = await deps.store.getOrganization(invitation.tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(
				`Organization ${JSON.stringify(invitation.tenantId)} is unknown.`,
			);
		}
		if (organization.status !== "enabled") {
			throw new OrganizationNotEnabledError(
				`Organization ${JSON.stringify(invitation.tenantId)} is not enabled.`,
			);
		}
		if (acceptor.email !== invitation.email) {
			throw new InvitationEmailMismatchError(
				`Invitation ${JSON.stringify(invitationId)} does not match ${JSON.stringify(acceptor.email)}.`,
			);
		}
		const existing = await deps.store.getMembership(invitation.tenantId, acceptor.userId);
		if (existing !== null) {
			throw new DuplicateMembershipError(
				`User ${JSON.stringify(acceptor.userId)} already belongs to ${JSON.stringify(invitation.tenantId)}.`,
			);
		}
		const membership: Membership = {
			tenantId: invitation.tenantId,
			userId: acceptor.userId,
			role: invitation.role,
			joinedAt: now,
		};
		await deps.store.putMembership(membership);
		const accepted: Invitation = {
			...invitation,
			status: "accepted",
		};
		await deps.store.putInvitation(accepted);
		return membership;
	}

	async listOrganizationsForUser(userId: string, deps: { store: MessagingStore }): Promise<Organization[]> {
		return deps.store.listOrganizationsForUser(userId);
	}
}
