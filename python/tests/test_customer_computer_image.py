"""Unit tests for customer computer image helpers."""

from __future__ import annotations

import pytest

from chatticus.customer_computer_image import (
    DEV_IMAGE_TAG,
    customer_image_tag_exists,
    publish_dev_image_from_anthus,
    repository_name_from_uri,
    require_customer_computer_image,
)
from chatticus.models import OrganizationComputerProvisioningError


class _FakeEcr:
    def __init__(
        self,
        *,
        tags: set[str] | None = None,
        anthus_manifest: str | None = None,
    ) -> None:
        self.tags = set(tags or [])
        self.anthus_manifest = anthus_manifest
        self.put_image_calls: list[dict[str, object]] = []

    def describe_images(
        self,
        *,
        repositoryName: str,
        imageIds: list[dict[str, str]],
    ) -> dict[str, object]:
        del repositoryName
        tag = imageIds[0]["imageTag"]
        if tag in self.tags:
            return {"imageDetails": [{"imageTags": [tag]}]}
        return {"imageDetails": []}

    def batch_get_image(
        self,
        *,
        repositoryName: str,
        imageIds: list[dict[str, str]],
    ) -> dict[str, object]:
        del repositoryName
        tag = imageIds[0]["imageTag"]
        if self.anthus_manifest is None:
            return {"failures": [{"imageTag": tag}]}
        return {
            "images": [{"imageManifest": self.anthus_manifest}],
            "failures": [],
        }

    def put_image(
        self,
        *,
        repositoryName: str,
        imageManifest: str,
        imageTag: str,
    ) -> dict[str, object]:
        self.put_image_calls.append(
            {
                "repositoryName": repositoryName,
                "imageManifest": imageManifest,
                "imageTag": imageTag,
            }
        )
        self.tags.add(imageTag)
        return {}


def test_repository_name_from_uri() -> None:
    uri = (
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage"
    )
    assert repository_name_from_uri(uri) == "chatticuscomputers-computerimage"


def test_customer_image_tag_exists() -> None:
    ecr = _FakeEcr(tags={"dev"})
    assert (
        customer_image_tag_exists(
            ecr,
            repository_name="chatticuscomputers-computerimage",
        )
        is True
    )
    ecr.tags.clear()
    assert (
        customer_image_tag_exists(
            ecr,
            repository_name="chatticuscomputers-computerimage",
        )
        is False
    )


def test_require_customer_computer_image_refuses_when_missing() -> None:
    ecr = _FakeEcr()
    repository_uri = (
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage"
    )
    with pytest.raises(OrganizationComputerProvisioningError, match="missing"):
        require_customer_computer_image(ecr, repository_uri=repository_uri)


def test_require_customer_computer_image_returns_uri() -> None:
    ecr = _FakeEcr(tags={DEV_IMAGE_TAG})
    repository_uri = (
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage"
    )
    assert (
        require_customer_computer_image(ecr, repository_uri=repository_uri)
        == f"{repository_uri}:{DEV_IMAGE_TAG}"
    )


def test_publish_dev_image_from_anthus() -> None:
    anthus = _FakeEcr(anthus_manifest='{"schemaVersion":2}')
    customer = _FakeEcr()
    publish_dev_image_from_anthus(
        anthus,
        customer,
        anthus_repository_name="anthus-repo",
        customer_repository_name="customer-repo",
    )
    assert len(customer.put_image_calls) == 1
    assert customer.put_image_calls[0]["repositoryName"] == "customer-repo"
    assert customer.put_image_calls[0]["imageTag"] == DEV_IMAGE_TAG
