"""Organization identity and membership kernel for store-level scenarios."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from uuid import uuid4

from chatticus.cross_account_provisioning import (
    CrossAccountRoleInspector,
    organization_after_accepted_self_setup,
    validate_cross_account_role_for_self_setup,
)
from chatticus.deployment_aws_account import caller_aws_account_id
from chatticus.messaging.store import MessagingStore
from chatticus.models import (
    AwsSetupPath,
    DuplicateMembershipError,
    Identity,
    IdentityUserIdMismatchError,
    Invitation,
    InvitationEmailMismatchError,
    InvitationExpiredError,
    InvitationNotFoundError,
    InvitationNotPendingError,
    InvitationStatus,
    LastOwnerCannotBeDemotedError,
    MemberRole,
    Membership,
    MembershipNotFoundError,
    NotOrganizationOwnerError,
    Organization,
    OrganizationNotEnabledError,
    OrganizationNotFoundError,
    OrganizationSeedConflictError,
    OrganizationStatus,
    OrganizationStatusTransitionError,
    SelfSetupCrossAccountResult,
)

ANTHUS_TENANT_ID = "anthus"
ANTHUS_LEGACY_USER_ID = "ryan"


def normalize_email(email: str) -> str:
    """Normalize a verified email for identity and invitation keys.

    Lowercase and strip surrounding whitespace only. Dots and plus-tags are
    kept exactly; ``foo.bar@gmail.com`` and ``foobar@gmail.com`` are
    different keys.
    """
    return email.strip().lower()


@dataclass
class OrgRecordsKernel:
    """Drive organization record scenarios from Gherkin and kernel tests."""

    store: MessagingStore
    invitation_ttl_days: int = 7

    def sign_in(self, email: str, *, now: datetime) -> Identity:
        """Mint an identity on first sight of an email; idempotent on repeat."""
        normalized = normalize_email(email)
        existing = self.store.get_identity_by_email(normalized)
        if existing is not None:
            return existing
        identity = Identity(
            user_id=str(uuid4()),
            email=normalized,
            created_at=now,
        )
        self.store.put_identity(identity)
        return identity

    def create_organization(
        self, owner: Identity, name: str, *, now: datetime
    ) -> Organization:
        """Create a pending organization and owner membership."""
        tenant_id = str(uuid4())
        return self.store.create_pending_organization(
            owner,
            name,
            tenant_id=tenant_id,
            now=now,
            enforce_owner_cap=True,
        )

    def admin_create_organization(
        self, owner: Identity, name: str, *, now: datetime
    ) -> Organization:
        """Create a pending organization without the product owner cap."""
        tenant_id = str(uuid4())
        return self.store.create_pending_organization(
            owner,
            name,
            tenant_id=tenant_id,
            now=now,
            enforce_owner_cap=False,
        )

    def admin_seed_organization(
        self,
        tenant_id: str,
        owner_email: str,
        *,
        name: str,
        now: datetime,
    ) -> Organization:
        """Seed one tenant enabled for one owner without touching messaging rows."""
        owner = self._admin_ensure_seed_owner_identity(
            tenant_id,
            owner_email,
            now=now,
        )
        existing = self.store.get_organization(tenant_id)
        if existing is not None:
            return self._finish_seed(tenant_id, existing, owner)
        organization = Organization(
            tenant_id=tenant_id,
            name=name,
            status=OrganizationStatus.ENABLED,
            owner_user_id=owner.user_id,
            created_at=now,
            aws_account_id=caller_aws_account_id(),
            aws_setup_path=AwsSetupPath.ANTHUS_MANAGED,
        )
        self.store.put_organization(organization)
        self.store.put_membership(
            Membership(
                tenant_id=tenant_id,
                user_id=owner.user_id,
                role=MemberRole.OWNER,
                joined_at=now,
            )
        )
        return organization

    def _apply_seed_aws_home(self, organization: Organization) -> Organization:
        if organization.aws_account_id is not None:
            return organization
        updated = replace(
            organization,
            aws_account_id=caller_aws_account_id(),
            aws_setup_path=AwsSetupPath.ANTHUS_MANAGED,
        )
        self.store.put_organization(updated)
        return updated

    def _put_pending_organization(
        self,
        owner: Identity,
        name: str,
        *,
        tenant_id: str,
        now: datetime,
    ) -> Organization:
        organization = Organization(
            tenant_id=tenant_id,
            name=name,
            status=OrganizationStatus.PENDING,
            owner_user_id=owner.user_id,
            created_at=now,
        )
        self.store.put_organization(organization)
        self.store.put_membership(
            Membership(
                tenant_id=tenant_id,
                user_id=owner.user_id,
                role=MemberRole.OWNER,
                joined_at=now,
            )
        )
        return organization

    def _admin_ensure_seed_owner_identity(
        self,
        tenant_id: str,
        owner_email: str,
        *,
        now: datetime,
    ) -> Identity:
        messaging_user_ids = self.store.list_messaging_user_ids(tenant_id)
        if len(messaging_user_ids) > 1:
            raise OrganizationSeedConflictError(
                f"Tenant {tenant_id!r} has multiple messaging user ids "
                f"{list(messaging_user_ids)!r}; seed requires exactly one."
            )
        if not messaging_user_ids:
            return self.sign_in(owner_email, now=now)
        expected_user_id = messaging_user_ids[0]
        normalized = normalize_email(owner_email)
        existing = self.store.get_identity_by_email(normalized)
        if existing is not None:
            if existing.user_id != expected_user_id:
                raise IdentityUserIdMismatchError(
                    f"Identity for {normalized!r} has user_id "
                    f"{existing.user_id!r}; seed for tenant {tenant_id!r} "
                    f"requires {expected_user_id!r} for legacy messaging rows."
                )
            return existing
        identity = Identity(
            user_id=expected_user_id,
            email=normalized,
            created_at=now,
        )
        self.store.put_identity(identity)
        return identity

    def _finish_seed(
        self,
        tenant_id: str,
        existing: Organization,
        owner: Identity,
    ) -> Organization:
        if existing.owner_user_id != owner.user_id:
            raise OrganizationSeedConflictError(
                f"Organization {tenant_id!r} already has owner "
                f"{existing.owner_user_id!r}; seed requested "
                f"{owner.user_id!r}."
            )
        membership = self.store.get_membership(tenant_id, owner.user_id)
        if membership is None or membership.role != MemberRole.OWNER:
            raise OrganizationSeedConflictError(
                f"Organization {tenant_id!r} is missing an owner "
                f"membership for {owner.user_id!r}."
            )
        if existing.status == OrganizationStatus.ENABLED:
            return self._apply_seed_aws_home(existing)
        if existing.status == OrganizationStatus.PENDING:
            enabled = self.enable_organization(tenant_id)
            return self._apply_seed_aws_home(enabled)
        raise OrganizationSeedConflictError(
            f"Organization {tenant_id!r} has status "
            f"{existing.status!r}; seed requires pending or enabled."
        )

    def enable_organization(self, tenant_id: str) -> Organization:
        """Mark one organization enabled."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        if organization.status != OrganizationStatus.PENDING:
            raise OrganizationStatusTransitionError(
                f"Organization {tenant_id!r} has status "
                f"{organization.status!r}; enable requires pending."
            )
        enabled = replace(organization, status=OrganizationStatus.ENABLED)
        self.store.put_organization(enabled)
        return enabled

    def provision_organization_aws(
        self,
        tenant_id: str,
        account_id: str,
        cross_account_role: str,
        external_id: str,
        setup_path: AwsSetupPath,
    ) -> Organization:
        """Record the AWS account details for a provisioned organization."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        provisioned = replace(
            organization,
            aws_account_id=account_id,
            aws_cross_account_role=cross_account_role,
            aws_external_id=external_id,
            aws_setup_path=setup_path,
        )
        self.store.put_organization(provisioned)
        return provisioned

    def submit_self_setup_cross_account_role(
        self,
        tenant_id: str,
        *,
        account_id: str,
        cross_account_role: str,
        role_inspector: CrossAccountRoleInspector,
    ) -> SelfSetupCrossAccountResult:
        """Validate and accept one customer self-setup cross-account submission."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        decision = validate_cross_account_role_for_self_setup(
            organization,
            account_id=account_id,
            cross_account_role=cross_account_role,
            role_inspector=role_inspector,
        )
        if not decision.accepted:
            return decision
        provisioned = organization_after_accepted_self_setup(
            organization,
            account_id=account_id,
            cross_account_role=cross_account_role,
        )
        self.store.put_organization(provisioned)
        return SelfSetupCrossAccountResult(
            accepted=True,
            organization=provisioned,
            message=None,
        )

    def suspend_organization(self, tenant_id: str) -> Organization:
        """Mark one organization suspended."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        if organization.status != OrganizationStatus.ENABLED:
            raise OrganizationStatusTransitionError(
                f"Organization {tenant_id!r} has status "
                f"{organization.status!r}; suspend requires enabled."
            )
        suspended = replace(organization, status=OrganizationStatus.SUSPENDED)
        self.store.put_organization(suspended)
        return suspended

    def reinstate_organization(self, tenant_id: str) -> Organization:
        """Mark one suspended organization enabled again."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        if organization.status != OrganizationStatus.SUSPENDED:
            raise OrganizationStatusTransitionError(
                f"Organization {tenant_id!r} has status "
                f"{organization.status!r}; reinstate requires suspended."
            )
        reinstated = replace(organization, status=OrganizationStatus.ENABLED)
        self.store.put_organization(reinstated)
        return reinstated

    def set_member_role(
        self,
        tenant_id: str,
        actor_user_id: str,
        member_user_id: str,
        role: MemberRole,
    ) -> Membership:
        """Change one member's role; only an owner may call this."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        actor = self.store.get_membership(tenant_id, actor_user_id)
        if actor is None or actor.role != MemberRole.OWNER:
            raise NotOrganizationOwnerError(
                f"User {actor_user_id!r} is not an owner of {tenant_id!r}."
            )
        membership = self.store.get_membership(tenant_id, member_user_id)
        if membership is None:
            raise MembershipNotFoundError(
                f"User {member_user_id!r} is not a member of {tenant_id!r}."
            )
        if membership.role == MemberRole.OWNER and role != MemberRole.OWNER:
            other_owners = [
                item
                for item in self.store.list_memberships(tenant_id)
                if item.role == MemberRole.OWNER and item.user_id != member_user_id
            ]
            if not other_owners:
                raise LastOwnerCannotBeDemotedError(
                    f"User {member_user_id!r} is the last owner of {tenant_id!r}."
                )
        updated = replace(membership, role=role)
        self.store.put_membership(updated)
        return updated

    def admin_set_member_role(
        self,
        tenant_id: str,
        member_user_id: str,
        role: MemberRole,
    ) -> Membership:
        """Change one member's role on the admin path."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        membership = self.store.get_membership(tenant_id, member_user_id)
        if membership is None:
            raise MembershipNotFoundError(
                f"User {member_user_id!r} is not a member of {tenant_id!r}."
            )
        if membership.role == MemberRole.OWNER and role != MemberRole.OWNER:
            other_owners = [
                item
                for item in self.store.list_memberships(tenant_id)
                if item.role == MemberRole.OWNER and item.user_id != member_user_id
            ]
            if not other_owners:
                raise LastOwnerCannotBeDemotedError(
                    f"User {member_user_id!r} is the last owner of {tenant_id!r}."
                )
        updated = replace(membership, role=role)
        self.store.put_membership(updated)
        return updated

    def invite_by_email(
        self,
        tenant_id: str,
        inviter_user_id: str,
        email: str,
        *,
        now: datetime,
    ) -> Invitation:
        """Create a pending invitation from an owner."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        self.assert_may_invite_members(tenant_id, inviter_user_id)
        normalized = normalize_email(email)
        invitation = Invitation(
            invitation_id=str(uuid4()),
            tenant_id=tenant_id,
            email=normalized,
            invited_by_user_id=inviter_user_id,
            role=MemberRole.MEMBER,
            status=InvitationStatus.PENDING,
            expires_at=now + timedelta(days=self.invitation_ttl_days),
            created_at=now,
        )
        self.store.put_invitation(invitation)
        return invitation

    def assert_may_invite_members(
        self, tenant_id: str, actor_user_id: str
    ) -> Membership:
        """Return membership when the actor may invite; owner-only for now."""
        membership = self.store.get_membership(tenant_id, actor_user_id)
        if membership is None or membership.role != MemberRole.OWNER:
            raise NotOrganizationOwnerError(
                f"User {actor_user_id!r} is not an owner of {tenant_id!r}."
            )
        return membership

    def reconcile_pending_invitations(
        self,
        acceptor: Identity,
        *,
        now: datetime,
    ) -> None:
        """Accept eligible pending invitations for one verified email.

        Expired invitations and invitations to non-enabled organizations are
        skipped without failing the caller.
        """
        for invitation in self.store.list_pending_invitations_for_email(acceptor.email):
            if invitation.expires_at <= now:
                continue
            organization = self.store.get_organization(invitation.tenant_id)
            if organization is None:
                continue
            if organization.status != OrganizationStatus.ENABLED:
                continue
            try:
                self.accept_invitation(invitation.invitation_id, acceptor, now=now)
            except (
                DuplicateMembershipError,
                InvitationEmailMismatchError,
                InvitationExpiredError,
                InvitationNotFoundError,
                InvitationNotPendingError,
                OrganizationNotEnabledError,
                OrganizationNotFoundError,
            ):
                continue

    def accept_invitation(
        self,
        invitation_id: str,
        acceptor: Identity,
        *,
        now: datetime,
    ) -> Membership:
        """Accept one invitation when the organization is enabled."""
        invitation = self.store.get_invitation(invitation_id)
        if invitation is None:
            raise InvitationNotFoundError(f"Invitation {invitation_id!r} is unknown.")
        if invitation.status != InvitationStatus.PENDING:
            raise InvitationNotPendingError(
                f"Invitation {invitation_id!r} is not pending."
            )
        if invitation.expires_at <= now:
            raise InvitationExpiredError(f"Invitation {invitation_id!r} has expired.")
        organization = self.store.get_organization(invitation.tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(
                f"Organization {invitation.tenant_id!r} is unknown."
            )
        if organization.status != OrganizationStatus.ENABLED:
            raise OrganizationNotEnabledError(
                f"Organization {invitation.tenant_id!r} is not enabled."
            )
        if acceptor.email != invitation.email:
            raise InvitationEmailMismatchError(
                f"Invitation {invitation_id!r} does not match {acceptor.email!r}."
            )
        existing = self.store.get_membership(invitation.tenant_id, acceptor.user_id)
        if existing is not None:
            raise DuplicateMembershipError(
                f"User {acceptor.user_id!r} already belongs to "
                f"{invitation.tenant_id!r}."
            )
        membership = Membership(
            tenant_id=invitation.tenant_id,
            user_id=acceptor.user_id,
            role=invitation.role,
            joined_at=now,
        )
        self.store.put_membership(membership)
        accepted = replace(invitation, status=InvitationStatus.ACCEPTED)
        self.store.put_invitation(accepted)
        return membership

    def list_organizations_for_user(self, user_id: str) -> list[Organization]:
        """Return every organization a user belongs to."""
        return self.store.list_organizations_for_user(user_id)

    def list_organizations_by_status(
        self, status: OrganizationStatus
    ) -> list[Organization]:
        """Return every organization with one lifecycle status."""
        return self.store.list_organizations_by_status(status)

    def get_organization(self, tenant_id: str) -> Organization:
        """Load one organization."""
        organization = self.store.get_organization(tenant_id)
        if organization is None:
            raise OrganizationNotFoundError(f"Organization {tenant_id!r} is unknown.")
        return organization
