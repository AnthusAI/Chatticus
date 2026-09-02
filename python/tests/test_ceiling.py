"""Exhaustive unit tests for member authority ceilings and clipping."""

from __future__ import annotations

from decimal import Decimal

import pytest

from chatticus.capability_policy import TaskCapabilityGrant
from chatticus.ceiling import Ceiling, clip, grant_exceeds_ceiling


def _grant(
    *,
    tools: frozenset[str] | None = None,
    origins: frozenset[str] | None = None,
    recipients: frozenset[str] | None = None,
    file_scopes: frozenset[str] | None = None,
    egress_classes: frozenset[str] | None = None,
    ingest_classes: frozenset[str] | None = None,
) -> TaskCapabilityGrant:
    return TaskCapabilityGrant(
        tools=tools or frozenset(),
        origins=origins or frozenset(),
        recipients=recipients or frozenset(),
        file_scopes=file_scopes or frozenset(),
        egress_classes=egress_classes or frozenset(),
        ingest_classes=ingest_classes or frozenset(),
    )


def _ceiling(
    *,
    action_types: frozenset[str] | None = None,
    origins: frozenset[str] | None = None,
    recipients: frozenset[str] | None = None,
    file_scopes: frozenset[str] | None = None,
    egress_classes: frozenset[str] | None = None,
    ingest_classes: frozenset[str] | None = None,
    spend_limit: Decimal | None = None,
) -> Ceiling:
    return Ceiling(
        action_types=action_types or frozenset(),
        origins=origins or frozenset(),
        recipients=recipients or frozenset(),
        file_scopes=file_scopes or frozenset(),
        egress_classes=egress_classes or frozenset(),
        ingest_classes=ingest_classes or frozenset(),
        spend_limit=spend_limit,
    )


def test_ceiling_stores_all_fields() -> None:
    ceiling = _ceiling(
        action_types=frozenset({"send", "publish"}),
        origins=frozenset({"https://docs.example.com"}),
        recipients=frozenset({"alex@example.com"}),
        file_scopes=frozenset({"/workspace/research"}),
        egress_classes=frozenset({"structured_send"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
        spend_limit=Decimal("500.00"),
    )

    assert ceiling.action_types == frozenset({"send", "publish"})
    assert ceiling.origins == frozenset({"https://docs.example.com"})
    assert ceiling.recipients == frozenset({"alex@example.com"})
    assert ceiling.file_scopes == frozenset({"/workspace/research"})
    assert ceiling.egress_classes == frozenset({"structured_send"})
    assert ceiling.ingest_classes == frozenset({"approved_origin_reference"})
    assert ceiling.spend_limit == Decimal("500.00")


def test_ceiling_defaults_spend_limit_to_none() -> None:
    ceiling = _ceiling(action_types=frozenset({"send"}))
    assert ceiling.spend_limit is None


def test_ceiling_is_frozen() -> None:
    ceiling = _ceiling(action_types=frozenset({"send"}))
    with pytest.raises(AttributeError):
        ceiling.action_types = frozenset({"publish"})  # type: ignore[misc]


@pytest.mark.parametrize(
    ("grant_tools", "ceiling_action_types", "expected_tools"),
    [
        (frozenset({"send"}), frozenset({"send", "publish"}), frozenset({"send"})),
        (frozenset({"send", "publish"}), frozenset({"send"}), frozenset({"send"})),
        (frozenset({"send", "delete"}), frozenset({"publish"}), frozenset()),
        (frozenset(), frozenset({"send"}), frozenset()),
        (frozenset({"send"}), frozenset(), frozenset()),
    ],
)
def test_clip_intersects_action_types(
    grant_tools: frozenset[str],
    ceiling_action_types: frozenset[str],
    expected_tools: frozenset[str],
) -> None:
    grant = _grant(tools=grant_tools)
    ceiling = _ceiling(action_types=ceiling_action_types)

    clipped = clip(grant, ceiling)

    assert clipped.tools == expected_tools


@pytest.mark.parametrize(
    ("grant_origins", "ceiling_origins", "expected_origins"),
    [
        (
            frozenset({"https://a.example"}),
            frozenset({"https://a.example", "https://b.example"}),
            frozenset({"https://a.example"}),
        ),
        (
            frozenset({"https://a.example", "https://c.example"}),
            frozenset({"https://a.example"}),
            frozenset({"https://a.example"}),
        ),
        (frozenset({"https://a.example"}), frozenset(), frozenset()),
    ],
)
def test_clip_intersects_origins(
    grant_origins: frozenset[str],
    ceiling_origins: frozenset[str],
    expected_origins: frozenset[str],
) -> None:
    grant = _grant(origins=grant_origins)
    ceiling = _ceiling(origins=ceiling_origins)

    clipped = clip(grant, ceiling)

    assert clipped.origins == expected_origins


@pytest.mark.parametrize(
    ("grant_recipients", "ceiling_recipients", "expected_recipients"),
    [
        (
            frozenset({"alex@example.com"}),
            frozenset({"alex@example.com", "other@example.com"}),
            frozenset({"alex@example.com"}),
        ),
        (
            frozenset({"alex@example.com", "vendor@example.com"}),
            frozenset({"alex@example.com"}),
            frozenset({"alex@example.com"}),
        ),
        (
            frozenset({"other@example.com"}),
            frozenset({"alex@example.com"}),
            frozenset(),
        ),
    ],
)
def test_clip_intersects_recipients(
    grant_recipients: frozenset[str],
    ceiling_recipients: frozenset[str],
    expected_recipients: frozenset[str],
) -> None:
    grant = _grant(recipients=grant_recipients)
    ceiling = _ceiling(recipients=ceiling_recipients)

    clipped = clip(grant, ceiling)

    assert clipped.recipients == expected_recipients


@pytest.mark.parametrize(
    ("grant_scopes", "ceiling_scopes", "expected_scopes"),
    [
        (
            frozenset({"/workspace/research"}),
            frozenset({"/workspace/research", "/workspace/shared"}),
            frozenset({"/workspace/research"}),
        ),
        (
            frozenset({"/workspace/research", "/workspace/tmp"}),
            frozenset({"/workspace/research"}),
            frozenset({"/workspace/research"}),
        ),
        (
            frozenset({"/workspace/tmp"}),
            frozenset({"/workspace/research"}),
            frozenset(),
        ),
    ],
)
def test_clip_intersects_file_scopes(
    grant_scopes: frozenset[str],
    ceiling_scopes: frozenset[str],
    expected_scopes: frozenset[str],
) -> None:
    grant = _grant(file_scopes=grant_scopes)
    ceiling = _ceiling(file_scopes=ceiling_scopes)

    clipped = clip(grant, ceiling)

    assert clipped.file_scopes == expected_scopes


@pytest.mark.parametrize(
    ("grant_egress", "ceiling_egress", "expected_egress"),
    [
        (
            frozenset({"structured_send"}),
            frozenset({"structured_send", "file_transfer"}),
            frozenset({"structured_send"}),
        ),
        (
            frozenset({"structured_send", "approved_origin_fetch"}),
            frozenset({"structured_send"}),
            frozenset({"structured_send"}),
        ),
        (frozenset({"file_transfer"}), frozenset({"structured_send"}), frozenset()),
    ],
)
def test_clip_intersects_egress_classes(
    grant_egress: frozenset[str],
    ceiling_egress: frozenset[str],
    expected_egress: frozenset[str],
) -> None:
    grant = _grant(egress_classes=grant_egress)
    ceiling = _ceiling(egress_classes=ceiling_egress)

    clipped = clip(grant, ceiling)

    assert clipped.egress_classes == expected_egress


@pytest.mark.parametrize(
    ("grant_ingest", "ceiling_ingest", "expected_ingest"),
    [
        (
            frozenset({"approved_origin_reference"}),
            frozenset({"approved_origin_reference"}),
            frozenset({"approved_origin_reference"}),
        ),
        (
            frozenset({"approved_origin_reference"}),
            frozenset(),
            frozenset(),
        ),
        (frozenset(), frozenset({"approved_origin_reference"}), frozenset()),
    ],
)
def test_clip_intersects_ingest_classes(
    grant_ingest: frozenset[str],
    ceiling_ingest: frozenset[str],
    expected_ingest: frozenset[str],
) -> None:
    grant = _grant(ingest_classes=grant_ingest)
    ceiling = _ceiling(ingest_classes=ceiling_ingest)

    clipped = clip(grant, ceiling)

    assert clipped.ingest_classes == expected_ingest


def test_clip_grant_subset_of_ceiling_is_unchanged() -> None:
    grant = _grant(
        tools=frozenset({"send"}),
        origins=frozenset({"https://docs.example.com"}),
        recipients=frozenset({"alex@example.com"}),
        file_scopes=frozenset({"/workspace/research"}),
        egress_classes=frozenset({"structured_send"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )
    ceiling = _ceiling(
        action_types=frozenset({"send", "publish"}),
        origins=frozenset({"https://docs.example.com", "https://other.example.com"}),
        recipients=frozenset({"alex@example.com", "other@example.com"}),
        file_scopes=frozenset({"/workspace/research", "/workspace/shared"}),
        egress_classes=frozenset({"structured_send", "file_transfer"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
        spend_limit=Decimal("1000"),
    )

    assert clip(grant, ceiling) == grant
    assert grant_exceeds_ceiling(grant, ceiling) is False


def test_clip_grant_equal_to_ceiling_mapped_fields() -> None:
    grant = _grant(
        tools=frozenset({"send"}),
        recipients=frozenset({"alex@example.com"}),
        egress_classes=frozenset({"structured_send"}),
    )
    ceiling = _ceiling(
        action_types=frozenset({"send"}),
        recipients=frozenset({"alex@example.com"}),
        egress_classes=frozenset({"structured_send"}),
    )

    assert clip(grant, ceiling) == grant


def test_clip_grant_beyond_ceiling_is_refused() -> None:
    grant = _grant(
        tools=frozenset({"send"}),
        recipients=frozenset({"other@example.com"}),
        egress_classes=frozenset({"structured_send"}),
    )
    ceiling = _ceiling(
        action_types=frozenset({"send"}),
        recipients=frozenset({"alex@example.com"}),
        egress_classes=frozenset({"structured_send"}),
    )

    clipped = clip(grant, ceiling)

    assert clipped.recipients == frozenset()
    assert clipped != grant
    assert grant_exceeds_ceiling(grant, ceiling) is True


def test_clip_all_fields_together() -> None:
    grant = _grant(
        tools=frozenset({"send", "publish"}),
        origins=frozenset({"https://a.example", "https://b.example"}),
        recipients=frozenset({"alex@example.com", "other@example.com"}),
        file_scopes=frozenset({"/workspace/a", "/workspace/b"}),
        egress_classes=frozenset({"structured_send", "file_transfer"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )
    ceiling = _ceiling(
        action_types=frozenset({"send", "delete"}),
        origins=frozenset({"https://a.example"}),
        recipients=frozenset({"alex@example.com"}),
        file_scopes=frozenset({"/workspace/a"}),
        egress_classes=frozenset({"structured_send"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )

    clipped = clip(grant, ceiling)

    assert clipped == _grant(
        tools=frozenset({"send"}),
        origins=frozenset({"https://a.example"}),
        recipients=frozenset({"alex@example.com"}),
        file_scopes=frozenset({"/workspace/a"}),
        egress_classes=frozenset({"structured_send"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )


def test_clip_ceiling_to_ceiling_intersects_all_fields() -> None:
    delegate = _ceiling(
        action_types=frozenset({"send", "publish"}),
        origins=frozenset({"https://a.example", "https://b.example"}),
        recipients=frozenset({"alex@example.com", "other@example.com"}),
        file_scopes=frozenset({"/workspace/a", "/workspace/b"}),
        egress_classes=frozenset({"structured_send", "file_transfer"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
        spend_limit=Decimal("250"),
    )
    delegator = _ceiling(
        action_types=frozenset({"send", "delete"}),
        origins=frozenset({"https://a.example"}),
        recipients=frozenset({"alex@example.com"}),
        file_scopes=frozenset({"/workspace/a"}),
        egress_classes=frozenset({"structured_send"}),
        ingest_classes=frozenset(),
        spend_limit=Decimal("100"),
    )

    clipped = clip(delegate, delegator)

    assert clipped == _ceiling(
        action_types=frozenset({"send"}),
        origins=frozenset({"https://a.example"}),
        recipients=frozenset({"alex@example.com"}),
        file_scopes=frozenset({"/workspace/a"}),
        egress_classes=frozenset({"structured_send"}),
        ingest_classes=frozenset(),
        spend_limit=Decimal("100"),
    )


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        (Decimal("100"), Decimal("250"), Decimal("100")),
        (Decimal("250"), Decimal("100"), Decimal("100")),
        (None, Decimal("100"), Decimal("100")),
        (Decimal("100"), None, Decimal("100")),
        (None, None, None),
    ],
)
def test_clip_ceiling_spend_limit_uses_minimum(
    left: Decimal | None, right: Decimal | None, expected: Decimal | None
) -> None:
    clipped = clip(
        _ceiling(action_types=frozenset({"purchase"}), spend_limit=left),
        _ceiling(action_types=frozenset({"purchase"}), spend_limit=right),
    )

    assert clipped.spend_limit == expected


def test_clip_grant_does_not_touch_spend_limit() -> None:
    grant = _grant(tools=frozenset({"purchase"}))
    ceiling = _ceiling(action_types=frozenset({"purchase"}), spend_limit=Decimal("50"))

    clipped = clip(grant, ceiling)

    assert isinstance(clipped, TaskCapabilityGrant)
    assert clipped.tools == frozenset({"purchase"})


def test_argument_bound_action_types_share_class_but_differ_by_recipient() -> None:
    copy_edit_ceiling = _ceiling(
        action_types=frozenset({"publish"}),
        recipients=frozenset({"alex@example.com"}),
    )
    production_ceiling = _ceiling(
        action_types=frozenset({"publish"}),
        recipients=frozenset({"production.example.com"}),
    )
    copy_edit_grant = _grant(
        tools=frozenset({"publish"}),
        recipients=frozenset({"alex@example.com"}),
    )
    production_grant = _grant(
        tools=frozenset({"publish"}),
        recipients=frozenset({"production.example.com"}),
    )

    assert clip(copy_edit_grant, copy_edit_ceiling) == copy_edit_grant
    assert clip(production_grant, production_ceiling) == production_grant
    assert clip(copy_edit_grant, production_ceiling).recipients == frozenset()
    assert clip(production_grant, copy_edit_ceiling).recipients == frozenset()


def test_reference_ingest_members_differ_by_ingest_class_ceiling() -> None:
    reference_ingest_ceiling = _ceiling(
        action_types=frozenset({"browse"}),
        origins=frozenset({"https://docs.example.com"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )
    copy_edit_only_ceiling = _ceiling(
        action_types=frozenset({"browse"}),
        recipients=frozenset({"alex@example.com"}),
        ingest_classes=frozenset(),
    )
    reference_grant = _grant(
        tools=frozenset({"browse"}),
        origins=frozenset({"https://docs.example.com"}),
        ingest_classes=frozenset({"approved_origin_reference"}),
    )

    assert clip(reference_grant, reference_ingest_ceiling) == reference_grant
    assert clip(reference_grant, copy_edit_only_ceiling).ingest_classes == frozenset()
    assert grant_exceeds_ceiling(reference_grant, copy_edit_only_ceiling) is True
