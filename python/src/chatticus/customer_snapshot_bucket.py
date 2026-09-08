"""Customer organization snapshot bucket naming."""

from __future__ import annotations

import re

BUCKET_NAME_PREFIX = "chatticus-snapshots-"
_MAX_BUCKET_NAME_LENGTH = 63
_ORGANIZATION_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


class CustomerSnapshotBucketNameError(ValueError):
    """The organization id cannot form a valid customer snapshot bucket name."""


def customer_snapshot_bucket_name(organization_id: str) -> str:
    """Return the customer snapshot bucket name for one organization."""
    organization = organization_id.strip().lower()
    if not organization:
        raise CustomerSnapshotBucketNameError("organization_id must not be empty.")
    if not _ORGANIZATION_ID.fullmatch(organization):
        raise CustomerSnapshotBucketNameError(
            f"organization_id {organization_id!r} is not a valid bucket segment."
        )
    name = f"{BUCKET_NAME_PREFIX}{organization}"
    if len(name) > _MAX_BUCKET_NAME_LENGTH:
        raise CustomerSnapshotBucketNameError(
            f"Snapshot bucket name {name!r} exceeds "
            f"{_MAX_BUCKET_NAME_LENGTH} characters."
        )
    return name
