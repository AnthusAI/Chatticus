"""Kernel tests for executable capability and browser-context policy."""

from __future__ import annotations

from datetime import UTC, datetime

from chatticus.capability_policy import (
    V1_POLICY_EXCLUSIONS,
    BindingControl,
    BrowserContextKind,
    CapabilityPolicy,
    HouseholdCredential,
    RequestedCapability,
    TaskCapabilityGrant,
)
from chatticus.models import ApprovalDecision


def _now() -> datetime:
    return datetime(2026, 8, 31, 20, 0, tzinfo=UTC)


def _research_grant() -> TaskCapabilityGrant:
    return TaskCapabilityGrant(
        tools=frozenset({"browse", "read_workspace"}),
        origins=frozenset({"https://docs.example.com"}),
        recipients=frozenset(),
        file_scopes=frozenset({"/workspace/research"}),
        egress_classes=frozenset({"approved_origin_fetch"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )


def test_ungranted_origin_is_denied() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.set_grant(_research_grant())

    decision = policy.evaluate(
        RequestedCapability(
            tool="browse",
            origin="https://evil.example",
            egress_class="approved_origin_fetch",
        )
    )

    assert decision == ApprovalDecision.DENY
    assert policy.unblocked_egress == []
    assert policy.denials[0].reason


def test_granted_send_requires_immutable_approval() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.set_grant(
        TaskCapabilityGrant(
            tools=frozenset({"send"}),
            origins=frozenset(),
            recipients=frozenset({"alex@example.com"}),
            file_scopes=frozenset(),
            egress_classes=frozenset({"structured_send"}),
            ingest_classes=frozenset(),
        )
    )

    decision = policy.evaluate(
        RequestedCapability(
            tool="send",
            recipient="alex@example.com",
            egress_class="structured_send",
        )
    )

    assert decision == ApprovalDecision.REQUIRE_APPROVAL
    assert policy.last_binding == BindingControl.IMMUTABLE_APPROVAL


def test_untrusted_context_cannot_use_privileged_credentials() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.add_credential(HouseholdCredential("browser_session", "banking", "cookie"))
    context = policy.open_untrusted("https://untrusted.example")

    assert context.kind is BrowserContextKind.UNTRUSTED
    assert policy.context_may_use(context, "banking") is False
    assert policy.model_visible_secrets(context) == ()


def test_privileged_context_is_named_session_only() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.add_credential(HouseholdCredential("browser_session", "banking", "cookie"))
    policy.add_credential(HouseholdCredential("browser_session", "mail", "mail-cookie"))
    context = policy.open_privileged("https://bank.example", "banking")

    assert policy.context_may_use(context, "banking") is True
    assert policy.context_may_use(context, "mail") is False


def test_storage_partitions_do_not_share_cookies() -> None:
    policy = CapabilityPolicy(now=_now)
    untrusted = policy.open_untrusted("https://untrusted.example")
    privileged = policy.open_privileged("https://bank.example", "banking")
    policy.write_cookie(untrusted, "tracker", "a")
    policy.write_cookie(privileged, "session", "b")

    assert untrusted.storage_partition != privileged.storage_partition
    assert policy.cookie_in_context(privileged, "tracker") is None
    assert policy.cookie_in_context(untrusted, "session") is None


def test_encoded_injection_is_still_denied_at_the_sink() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.set_grant(_research_grant())
    policy.mark_injection_followed_by_model()

    decision = policy.evaluate(
        RequestedCapability(
            tool="browse",
            origin="https://evil.example",
            egress_class="approved_origin_fetch",
        )
    )

    assert decision == ApprovalDecision.DENY
    assert policy.sink_denial_is_control is True
    assert policy.prompt_wording_is_boundary is False


def test_unbound_browser_send_requires_stop() -> None:
    policy = CapabilityPolicy(now=_now)
    control = policy.required_binding_for_browser_action("send")

    assert control is BindingControl.UNBOUND_STOP
    assert "generic_browser_click_binding" in policy.recorded_exclusions


def test_connector_without_approval_does_not_execute() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.bind_connector("send", "alex@example.com", "hello")

    result = policy.execute_bound_connector()

    assert result.executed is False
    assert policy.last_binding is BindingControl.IMMUTABLE_APPROVAL


def test_approved_connector_executes_with_evidence() -> None:
    policy = CapabilityPolicy(now=_now)
    policy.bind_connector("send", "alex@example.com", "hello")
    policy.approve_bound_operation()

    result = policy.execute_bound_connector("smtp-250")

    assert result.executed is True
    assert result.completion_evidence == "smtp-250"


def test_v1_exclusions_are_named_and_unclaimed() -> None:
    policy = CapabilityPolicy(now=_now)
    for name in V1_POLICY_EXCLUSIONS:
        policy.record_exclusion(name)
        assert policy.worker_claims_enforced(name) is False
    assert policy.recorded_exclusions == set(V1_POLICY_EXCLUSIONS)
