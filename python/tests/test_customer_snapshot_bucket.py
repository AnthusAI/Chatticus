"""Unit tests for customer snapshot bucket naming."""

from __future__ import annotations

import pytest

from chatticus.customer_snapshot_bucket import (
    BUCKET_NAME_PREFIX,
    CustomerSnapshotBucketNameError,
    customer_snapshot_bucket_name,
)


def test_customer_snapshot_bucket_name_uses_organization_id_only() -> None:
    organization_id = "ORGANIZATION_ID"
    assert customer_snapshot_bucket_name(organization_id) == (
        f"{BUCKET_NAME_PREFIX}{organization_id}"
    )
    assert len(customer_snapshot_bucket_name(organization_id)) == (
        len(BUCKET_NAME_PREFIX) + len(organization_id)
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
