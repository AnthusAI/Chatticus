"""Organization identity and membership kernel for store-level scenarios."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from uuid import uuid4

from chatticus.messaging.store import MessagingStore
from chatticus.models import (
    DuplicateMembershipError,
    Identity,
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
    OrganizationStatus,
    OrganizationStatusTransitionError,
)


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
        membership = self.store.get_membership(tenant_id, inviter_user_id)
        if membership is None or membership.role != MemberRole.OWNER:
            raise NotOrganizationOwnerError(
                f"User {inviter_user_id!r} is not an owner of {tenant_id!r}."
            )
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
