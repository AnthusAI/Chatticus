"""Kernel tests for organization identity and membership records."""

from __future__ import annotations

from datetime import UTC, datetime

import boto3
import pytest
from moto import mock_aws

from chatticus.messaging.store import (
    DynamoMessagingStore,
    InMemoryMessagingStore,
    create_messaging_table,
)
from chatticus.models import (
    InvitationEmailMismatchError,
    InvitationStatus,
    LastOwnerCannotBeDemotedError,
    MemberRole,
    MembershipNotFoundError,
    NotOrganizationOwnerError,
    OrganizationNotEnabledError,
    OrganizationStatus,
    OrganizationStatusTransitionError,
)
from chatticus.org_records import OrgRecordsKernel, normalize_email

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Ryan@Example.COM", "ryan@example.com"),
        ("  sam@example.com  ", "sam@example.com"),
        ("foo.bar@gmail.com", "foo.bar@gmail.com"),
        ("foo.bar@googlemail.com", "foo.bar@googlemail.com"),
        ("foo.bar@example.com", "foo.bar@example.com"),
        ("foo+tag@gmail.com", "foo+tag@gmail.com"),
        ("a.b.c+tag@Gmail.com", "a.b.c+tag@gmail.com"),
    ],
)
def test_normalize_email(raw: str, expected: str) -> None:
    assert normalize_email(raw) == expected


def test_gmail_dot_variants_do_not_collide_for_identity() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    first = kernel.sign_in("foo.bar@gmail.com", now=NOW)
    second = kernel.sign_in("foobar@gmail.com", now=NOW)
    assert first.user_id != second.user_id


def test_plus_tag_variants_do_not_collide_for_identity() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    first = kernel.sign_in("foo@gmail.com", now=NOW)
    second = kernel.sign_in("foo+tag@gmail.com", now=NOW)
    assert first.user_id != second.user_id


def test_non_gmail_dots_do_not_collide() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    first = kernel.sign_in("foo.bar@example.com", now=NOW)
    second = kernel.sign_in("foobar@example.com", now=NOW)
    assert first.user_id != second.user_id


def test_sign_in_mints_and_is_idempotent() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    first = kernel.sign_in("ryan@example.com", now=NOW)
    again = kernel.sign_in("ryan@example.com", now=NOW)
    assert first.user_id == again.user_id


def test_create_organization_pending_with_owner() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    assert org.status == OrganizationStatus.PENDING
    membership = kernel.store.get_membership(org.tenant_id, owner.user_id)
    assert membership is not None
    assert membership.role == MemberRole.OWNER


def test_invite_creates_pending_invitation() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    assert invitation.status == InvitationStatus.PENDING
    assert invitation.email == "sam@example.com"


def test_accept_on_enabled_org_grants_membership() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    acceptor = kernel.sign_in("sam@example.com", now=NOW)
    membership = kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)
    assert membership.role == MemberRole.MEMBER
    orgs = kernel.list_organizations_for_user(acceptor.user_id)
    assert [loaded.tenant_id for loaded in orgs] == [org.tenant_id]


def test_accept_on_pending_org_raises() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    acceptor = kernel.sign_in("sam@example.com", now=NOW)
    with pytest.raises(OrganizationNotEnabledError):
        kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)


def test_invitation_email_match_uses_normalization() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    acceptor = kernel.sign_in("SAM@example.com", now=NOW)
    membership = kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)
    assert membership.user_id == acceptor.user_id


def test_gmail_dot_near_miss_invitation_does_not_match() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "foo.bar@gmail.com", now=NOW
    )
    acceptor = kernel.sign_in("foobar@gmail.com", now=NOW)
    with pytest.raises(InvitationEmailMismatchError):
        kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)


def test_suspend_organization_flips_status() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    suspended = kernel.suspend_organization(org.tenant_id)
    assert suspended.status == OrganizationStatus.SUSPENDED


def test_reinstate_organization_flips_status() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    kernel.suspend_organization(org.tenant_id)
    reinstated = kernel.reinstate_organization(org.tenant_id)
    assert reinstated.status == OrganizationStatus.ENABLED


def test_reinstate_organization_requires_suspended_status() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    with pytest.raises(OrganizationStatusTransitionError):
        kernel.reinstate_organization(org.tenant_id)
    kernel.enable_organization(org.tenant_id)
    with pytest.raises(OrganizationStatusTransitionError):
        kernel.reinstate_organization(org.tenant_id)


def test_accept_on_suspended_org_raises() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    kernel.suspend_organization(org.tenant_id)
    acceptor = kernel.sign_in("sam@example.com", now=NOW)
    with pytest.raises(OrganizationNotEnabledError):
        kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)


def test_owner_can_set_member_role() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    acceptor = kernel.sign_in("sam@example.com", now=NOW)
    kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)
    updated = kernel.set_member_role(
        org.tenant_id, owner.user_id, acceptor.user_id, MemberRole.OWNER
    )
    assert updated.role == MemberRole.OWNER


def test_member_cannot_set_role() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    acceptor = kernel.sign_in("sam@example.com", now=NOW)
    kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)
    with pytest.raises(NotOrganizationOwnerError):
        kernel.set_member_role(
            org.tenant_id, acceptor.user_id, acceptor.user_id, MemberRole.OWNER
        )


def test_last_owner_cannot_be_demoted() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    with pytest.raises(LastOwnerCannotBeDemotedError):
        kernel.set_member_role(
            org.tenant_id, owner.user_id, owner.user_id, MemberRole.MEMBER
        )


def test_owner_can_demote_when_another_owner_exists() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    acceptor = kernel.sign_in("sam@example.com", now=NOW)
    kernel.accept_invitation(invitation.invitation_id, acceptor, now=NOW)
    kernel.set_member_role(
        org.tenant_id, owner.user_id, acceptor.user_id, MemberRole.OWNER
    )
    updated = kernel.set_member_role(
        org.tenant_id, owner.user_id, owner.user_id, MemberRole.MEMBER
    )
    assert updated.role == MemberRole.MEMBER


def test_set_member_role_raises_for_missing_member() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    stranger = kernel.sign_in("stranger@example.com", now=NOW)
    with pytest.raises(MembershipNotFoundError):
        kernel.set_member_role(
            org.tenant_id, owner.user_id, stranger.user_id, MemberRole.MEMBER
        )


@mock_aws
def test_org_records_persist_in_dynamo_store() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    table_name = "chatticus-org-records"
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    kernel = OrgRecordsKernel(store)
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    kernel.enable_organization(org.tenant_id)
    recycled = OrgRecordsKernel(DynamoMessagingStore(table_name, client=client))
    loaded = recycled.list_organizations_for_user(owner.user_id)
    assert [item.tenant_id for item in loaded] == [org.tenant_id]


@mock_aws
def test_membership_dual_write_creates_user_org_index() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    table_name = "chatticus-org-membership-index"
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    kernel = OrgRecordsKernel(store)
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    response = client.get_item(
        TableName=table_name,
        Key={
            "pk": {"S": f"user#{owner.user_id}"},
            "sk": {"S": f"org#{org.tenant_id}"},
        },
    )
    assert response["Item"]["tenant_id"]["S"] == org.tenant_id


@mock_aws
def test_identity_dual_write_creates_email_lookup() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    table_name = "chatticus-org-identity-index"
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    kernel = OrgRecordsKernel(store)
    owner = kernel.sign_in("foo.bar@gmail.com", now=NOW)
    response = client.get_item(
        TableName=table_name,
        Key={
            "pk": {"S": "identity_lookup#foo.bar@gmail.com"},
            "sk": {"S": "meta"},
        },
    )
    assert response["Item"]["user_id"]["S"] == owner.user_id


@mock_aws
def test_invitation_dual_write_creates_lookup_item() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    table_name = "chatticus-org-invitation-index"
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    kernel = OrgRecordsKernel(store)
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    invitation = kernel.invite_by_email(
        org.tenant_id, owner.user_id, "sam@example.com", now=NOW
    )
    response = client.get_item(
        TableName=table_name,
        Key={
            "pk": {"S": f"invitation_lookup#{invitation.invitation_id}"},
            "sk": {"S": "meta"},
        },
    )
    assert response["Item"]["tenant_id"]["S"] == org.tenant_id
