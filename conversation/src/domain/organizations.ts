import { randomUUID } from "node:crypto";
import type { Decimal } from "../budget/decimal.ts";
import type { Clock } from "../storage/storage-support.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import {
	IdentityNotFoundError,
	IdentityUserIdMismatchError,
	OrganizationSeedConflictError,
	OrganizationNotFoundError,
	OrganizationNotEnabledError,
	OrganizationStatusTransitionError,
	InvitationNotFoundError,
	InvitationEmailMismatchError,
	InvitationExpiredError,
	InvitationNotPendingError,
	MembershipNotFoundError,
	DuplicateMembershipError,
	NotOrganizationOwnerError,
	LastOwnerCannotBeDemotedError,
} from "../http/errors.ts";

export {
	IdentityNotFoundError,
	IdentityUserIdMismatchError,
	OrganizationSeedConflictError,
	OrganizationNotFoundError,
	OrganizationNotEnabledError,
	OrganizationStatusTransitionError,
	InvitationNotFoundError,
	InvitationEmailMismatchError,
	InvitationExpiredError,
	InvitationNotPendingError,
	MembershipNotFoundError,
	DuplicateMembershipError,
	NotOrganizationOwnerError,
	LastOwnerCannotBeDemotedError,
};


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
	setupFeeCents: number | null;
	assistedSetupSession: boolean;
	monthlyAwsSpendCeilingUsd: Decimal | null;
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
	adminCreateOrganization(
		owner: Identity,
		name: string,
		deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	): Promise<Organization>;
	adminSeedOrganization(
		tenantId: string,
		ownerEmail: string,
		name: string,
		deps: SeedDependencies,
	): Promise<Organization>;
	provisionOrganizationAws(
		tenantId: string,
		awsHome: OrganizationAwsHome,
		deps: { store: MessagingStore },
	): Promise<Organization>;
	getOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization>;
	enableOrganization(tenantId: string, deps: LifecycleDependencies): Promise<Organization>;
	suspendOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization>;
	reinstateOrganization(tenantId: string, deps: LifecycleDependencies): Promise<Organization>;
	adminSetMemberRole(
		tenantId: string,
		memberUserId: string,
		role: MemberRole,
		deps: { store: MessagingStore },
	): Promise<Membership>;
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
	listOrganizationsByStatus(
		status: OrganizationStatus,
		deps: { store: MessagingStore },
	): Promise<Organization[]>;
}

/**
 * What enabling or reinstating an organization needs. The deployment account is the AWS home an organization that chose
 * no setup path is given when it becomes enabled.
 */
export interface LifecycleDependencies {
	store: MessagingStore;
	callerAwsAccountId?: () => Promise<string>;
}

/** What the seed needs; the caller account id is the home an Anthus-managed organization is recorded with. */
export interface SeedDependencies {
	store: MessagingStore;
	clock: Clock;
	ids: IdSource;
	callerAwsAccountId?: () => Promise<string>;
}

/** The AWS account details recorded for one provisioned organization. */
export interface OrganizationAwsHome {
	accountId: string;
	crossAccountRole: string;
	externalId: string;
	setupPath: AwsSetupPath;
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
			setupFeeCents: null,
			assistedSetupSession: false,
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

	/** Create a pending organization without the product owner cap. */
	async adminCreateOrganization(
		owner: Identity,
		name: string,
		deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	): Promise<Organization> {
		return this.createOrganization(owner, name, deps);
	}

	/**
	 * Seed one tenant enabled for one owner. The AWS account id of the caller
	 * is not recorded here; the setup path is anthus-managed.
	 */
	async adminSeedOrganization(
		tenantId: string,
		ownerEmail: string,
		name: string,
		deps: SeedDependencies,
	): Promise<Organization> {
		const owner = await this.signIn(ownerEmail, deps);
		const existing = await deps.store.getOrganization(tenantId);
		if (existing !== null) {
			return this.finishSeed(tenantId, existing, owner, deps);
		}
		const now = deps.clock.now();
		const organization: Organization = {
			tenantId,
			name,
			status: "enabled",
			ownerUserId: owner.userId,
			createdAt: now,
			awsAccountId: deps.callerAwsAccountId === undefined ? null : await deps.callerAwsAccountId(),
			awsCrossAccountRole: null,
			awsExternalId: null,
			awsSetupPath: "anthus-managed",
			setupFeeCents: null,
			assistedSetupSession: false,
			monthlyAwsSpendCeilingUsd: null,
		};
		await deps.store.putOrganization(organization);
		await deps.store.putMembership({
			tenantId,
			userId: owner.userId,
			role: "owner",
			joinedAt: now,
		});
		return organization;
	}

	private async withAnthusManagedHomeWhenUnchosen(
		organization: Organization,
		deps: LifecycleDependencies,
	): Promise<Organization> {
		if (organization.awsAccountId !== null || organization.awsSetupPath !== null || deps.callerAwsAccountId === undefined) {
			return organization;
		}
		return { ...organization, awsAccountId: await deps.callerAwsAccountId(), awsSetupPath: "anthus-managed" };
	}

	private async applySeedAwsHome(organization: Organization, deps: SeedDependencies): Promise<Organization> {
		if (organization.awsAccountId !== null || deps.callerAwsAccountId === undefined) {
			return organization;
		}
		const updated: Organization = {
			...organization,
			awsAccountId: await deps.callerAwsAccountId(),
			awsSetupPath: "anthus-managed",
		};
		await deps.store.putOrganization(updated);
		return updated;
	}

	private async finishSeed(
		tenantId: string,
		existing: Organization,
		owner: Identity,
		deps: SeedDependencies,
	): Promise<Organization> {
		if (existing.ownerUserId !== owner.userId) {
			throw new OrganizationSeedConflictError(
				`Organization ${JSON.stringify(tenantId)} already has owner ${JSON.stringify(existing.ownerUserId)}; seed requested ${JSON.stringify(owner.userId)}.`,
			);
		}
		const membership = await deps.store.getMembership(tenantId, owner.userId);
		if (membership === null || membership.role !== "owner") {
			throw new OrganizationSeedConflictError(
				`Organization ${JSON.stringify(tenantId)} is missing an owner membership for ${JSON.stringify(owner.userId)}.`,
			);
		}
		if (existing.status === "enabled") {
			return this.applySeedAwsHome(existing, deps);
		}
		if (existing.status === "pending") {
			return this.applySeedAwsHome(await this.enableOrganization(tenantId, deps), deps);
		}
		throw new OrganizationSeedConflictError(
			`Organization ${JSON.stringify(tenantId)} has status ${JSON.stringify(existing.status)}; seed requires pending or enabled.`,
		);
	}

	async getOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Organization> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		return organization;
	}

	/**
	 * Enable a pending organization. An organization with no AWS home and no chosen setup path becomes Anthus-managed:
	 * its home is the deployment account, exactly as the seed records it. An organization that chose a setup path
	 * (customer account or assisted) keeps its home as it is.
	 */
	async enableOrganization(tenantId: string, deps: LifecycleDependencies): Promise<Organization> {
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
			...(await this.withAnthusManagedHomeWhenUnchosen(organization, deps)),
			status: "enabled",
		};
		await deps.store.putOrganization(enabled);
		return enabled;
	}

	/**
	 * Record the AWS account details for a provisioned organization.
	 * Ported from python/src/chatticus/org_records.py lines 270-290.
	 */
	async provisionOrganizationAws(
		tenantId: string,
		awsHome: OrganizationAwsHome,
		deps: { store: MessagingStore },
	): Promise<Organization> {
		const organization = await deps.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		const provisioned: Organization = {
			...organization,
			awsAccountId: awsHome.accountId,
			awsCrossAccountRole: awsHome.crossAccountRole,
			awsExternalId: awsHome.externalId,
			awsSetupPath: awsHome.setupPath,
		};
		await deps.store.putOrganization(provisioned);
		return provisioned;
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

	/** Return a suspended organization to enabled, with the same Anthus-managed home rule as enabling it. */
	async reinstateOrganization(tenantId: string, deps: LifecycleDependencies): Promise<Organization> {
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
			...(await this.withAnthusManagedHomeWhenUnchosen(organization, deps)),
			status: "enabled",
		};
		await deps.store.putOrganization(reinstated);
		return reinstated;
	}

	/** Change one member's role on the admin path, with no acting owner. */
	async adminSetMemberRole(
		tenantId: string,
		memberUserId: string,
		role: MemberRole,
		deps: { store: MessagingStore },
	): Promise<Membership> {
		await this.getOrganization(tenantId, deps);
		const membership = await deps.store.getMembership(tenantId, memberUserId);
		if (membership === null) {
			throw new MembershipNotFoundError(
				`User ${JSON.stringify(memberUserId)} is not a member of ${JSON.stringify(tenantId)}.`,
			);
		}
		if (membership.role === "owner" && role !== "owner") {
			const memberships = await deps.store.listMemberships(tenantId);
			const hasOtherOwners = memberships.some((item) => item.role === "owner" && item.userId !== memberUserId);
			if (!hasOtherOwners) {
				throw new LastOwnerCannotBeDemotedError(
					`User ${JSON.stringify(memberUserId)} is the last owner of ${JSON.stringify(tenantId)}.`,
				);
			}
		}
		const updated: Membership = { ...membership, role };
		await deps.store.putMembership(updated);
		return updated;
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

	async listOrganizationsByStatus(
		status: OrganizationStatus,
		deps: { store: MessagingStore },
	): Promise<Organization[]> {
		return deps.store.listOrganizationsByStatus(status);
	}
}
