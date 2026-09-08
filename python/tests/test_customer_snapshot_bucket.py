"""Unit tests for customer snapshot bucket naming."""

from __future__ import annotations

import pytest

from chatticus.customer_snapshot_bucket import (
    BUCKET_NAME_PREFIX,
    CustomerSnapshotBucketNameError,
    customer_snapshot_bucket_name,
)

_SAMPLE_ORGANIZATION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"


def test_customer_snapshot_bucket_name_uses_lowercase_organization_id() -> None:
    assert customer_snapshot_bucket_name(_SAMPLE_ORGANIZATION_ID) == (
        f"{BUCKET_NAME_PREFIX}{_SAMPLE_ORGANIZATION_ID}"
    )
    assert customer_snapshot_bucket_name(_SAMPLE_ORGANIZATION_ID.upper()) == (
        f"{BUCKET_NAME_PREFIX}{_SAMPLE_ORGANIZATION_ID}"
    )


def test_customer_snapshot_bucket_name_rejects_empty() -> None:
    with pytest.raises(CustomerSnapshotBucketNameError, match="empty"):
        customer_snapshot_bucket_name("")


def test_customer_snapshot_bucket_name_rejects_invalid_characters() -> None:
    with pytest.raises(CustomerSnapshotBucketNameError, match="not a valid"):
        customer_snapshot_bucket_name("bad org id")


def test_customer_snapshot_bucket_name_rejects_too_long() -> None:
    organization_id = "x" * 50
    with pytest.raises(CustomerSnapshotBucketNameError, match="exceeds"):
        customer_snapshot_bucket_name(organization_id)
