"""Behave steps for organization identity and membership records."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when

from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import (
    InvitationStatus,
    MemberRole,
    OrganizationNotEnabledError,
    OrganizationStatus,
)
from chatticus.org_records import OrgRecordsKernel, normalize_email


def _kernel(context: object) -> OrgRecordsKernel:
    return context.org_kernel


def _org_by_name(context: object, name: str) -> object:
    org = context.orgs_by_name.get(name)
    if org is None:
        raise AssertionError(f"No organization named {name!r} in this scenario.")
    return org


@given("an empty organization records store")
def given_empty_org_store(context: object) -> None:
    context.org_store = InMemoryMessagingStore()
    context.org_kernel = OrgRecordsKernel(context.org_store)
    context.orgs_by_name = {}
    context.identities_by_email = {}
    context.current_identity = None
    context.last_invitation = None
    context.last_error = None
    context.now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


@when('"{email}" signs in for the first time')
@when('"{email}" signs in')
def when_signs_in(context: object, email: str) -> None:
    kernel = _kernel(context)
    identity = kernel.sign_in(email, now=context.now)
    context.current_identity = identity
    context.identities_by_email[email] = identity


@given('"{email}" has signed in')
def given_signed_in(context: object, email: str) -> None:
    when_signs_in(context, email)


@when('that user creates organization "{name}"')
def when_create_org(context: object, name: str) -> None:
    assert context.current_identity is not None
    org = _kernel(context).create_organization(
        context.current_identity, name, now=context.now
    )
    context.orgs_by_name[name] = org


@given('that user has created organization "{name}"')
def given_created_org(context: object, name: str) -> None:
    when_create_org(context, name)


@given('that user has created and enabled organization "{name}"')
def given_created_enabled_org(context: object, name: str) -> None:
    given_created_org(context, name)
    org = _org_by_name(context, name)
    enabled = _kernel(context).enable_organization(org.tenant_id)
    context.orgs_by_name[name] = enabled


@when('the owner of "{name}" invites "{email}"')
def when_owner_invites(context: object, name: str, email: str) -> None:
    org = _org_by_name(context, name)
    invitation = _kernel(context).invite_by_email(
        org.tenant_id,
        context.current_identity.user_id,
        email,
        now=context.now,
    )
    context.last_invitation = invitation


@given('the owner of "{name}" has invited "{email}"')
def given_owner_invited(context: object, name: str, email: str) -> None:
    when_owner_invites(context, name, email)


@when('that user accepts the invitation to "{name}"')
def when_accept_invitation(context: object, name: str) -> None:
    assert context.last_invitation is not None
    context.last_error = None
    _kernel(context).accept_invitation(
        context.last_invitation.invitation_id,
        context.current_identity,
        now=context.now,
    )


@when('that user tries to accept the invitation to "{name}"')
def when_try_accept_invitation(context: object, name: str) -> None:
    assert context.last_invitation is not None
    context.last_error = None
    try:
        _kernel(context).accept_invitation(
            context.last_invitation.invitation_id,
            context.current_identity,
            now=context.now,
        )
    except OrganizationNotEnabledError as error:
        context.last_error = error


@when("the store is recycled")
def when_store_recycled(context: object) -> None:
    recycled = InMemoryMessagingStore()
    for key, value in context.org_store.__dict__.items():
        if key.startswith("_"):
            setattr(recycled, key, value)
    context.org_kernel = OrgRecordsKernel(recycled)
    context.org_store = recycled


@then('an identity exists for "{email}"')
def then_identity_exists(context: object, email: str) -> None:
    identity = _kernel(context).sign_in(email, now=context.now)
    assert identity.user_id


@then('signing in again as "{email}" returns the same user id')
def then_same_user_id(context: object, email: str) -> None:
    first = context.identities_by_email[email]
    again = _kernel(context).sign_in(email, now=context.now)
    assert again.user_id == first.user_id


@then('organization "{name}" has status "{status}"')
def then_org_status(context: object, name: str, status: str) -> None:
    org = _org_by_name(context, name)
    loaded = _kernel(context).store.get_organization(org.tenant_id)
    assert loaded is not None
    assert loaded.status == OrganizationStatus(status)


@then('that user is an owner member of "{name}"')
def then_owner_member(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    membership = _kernel(context).store.get_membership(
        org.tenant_id, context.current_identity.user_id
    )
    assert membership is not None
    assert membership.role == MemberRole.OWNER


@then('a pending invitation exists for "{email}" in "{name}"')
def then_pending_invitation(context: object, email: str, name: str) -> None:
    org = _org_by_name(context, name)
    invitation = context.last_invitation
    assert invitation is not None
    assert invitation.tenant_id == org.tenant_id
    assert invitation.status == InvitationStatus.PENDING
    normalized = normalize_email(email)
    assert invitation.email == normalized


@then('"{email}" is a member of "{name}"')
def then_member(context: object, email: str, name: str) -> None:
    org = _org_by_name(context, name)
    identity = context.identities_by_email.get(email)
    if identity is None:
        identity = _kernel(context).sign_in(email, now=context.now)
    membership = _kernel(context).store.get_membership(org.tenant_id, identity.user_id)
    assert membership is not None
    assert membership.role == MemberRole.MEMBER


@then('listing organizations for that user includes "{name}"')
def then_list_includes(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    orgs = _kernel(context).list_organizations_for_user(
        context.current_identity.user_id
    )
    tenant_ids = {loaded.tenant_id for loaded in orgs}
    assert org.tenant_id in tenant_ids


@then("accepting the invitation is refused because the organization is not enabled")
def then_accept_refused_not_enabled(context: object) -> None:
    assert isinstance(context.last_error, OrganizationNotEnabledError)


@then('listing organizations for that user still includes "{name}"')
def then_list_still_includes(context: object, name: str) -> None:
    then_list_includes(context, name)
