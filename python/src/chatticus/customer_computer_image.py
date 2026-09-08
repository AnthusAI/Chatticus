"""Customer-account computer image presence and operator publish helpers."""

from __future__ import annotations

from typing import Any, Protocol

from botocore.exceptions import ClientError

from chatticus.models import OrganizationComputerProvisioningError

DEV_IMAGE_TAG = "dev"


class EcrImageCatalogClient(Protocol):
    """Subset of ECR client methods used to check and publish images."""

    def describe_images(
        self,
        *,
        repositoryName: str,
        imageIds: list[dict[str, str]],
    ) -> dict[str, Any]:
        """Return image metadata for one repository tag."""

    def batch_get_image(
        self,
        *,
        repositoryName: str,
        imageIds: list[dict[str, str]],
    ) -> dict[str, Any]:
        """Return one image manifest from a repository."""

    def get_download_url_for_layer(
        self,
        *,
        repositoryName: str,
        layerDigest: str,
    ) -> dict[str, Any]:
        """Return a pre-signed download URL for one image layer."""

    def initiate_layer_upload(self, *, repositoryName: str) -> dict[str, Any]:
        """Start uploading one image layer."""

    def upload_layer_part(
        self,
        *,
        repositoryName: str,
        uploadId: str,
        partFirstByte: int,
        partLastByte: int,
        layerPartBlob: bytes,
    ) -> dict[str, Any]:
        """Upload one part of an image layer."""

    def complete_layer_upload(
        self,
        *,
        repositoryName: str,
        uploadId: str,
        layerDigests: list[str],
    ) -> dict[str, Any]:
        """Finish uploading one image layer."""

    def put_image(
        self,
        *,
        repositoryName: str,
        imageManifest: str,
        imageTag: str,
    ) -> dict[str, Any]:
        """Register one image manifest under a tag."""


def repository_name_from_uri(repository_uri: str) -> str:
    """Return the repository name segment from one ECR repository URI."""
    name = repository_uri.rstrip("/").split("/")[-1].strip()
    if not name:
        msg = f"Could not parse repository name from URI {repository_uri!r}."
        raise ValueError(msg)
    return name


def customer_image_tag_exists(
    ecr_client: EcrImageCatalogClient,
    *,
    repository_name: str,
    tag: str = DEV_IMAGE_TAG,
) -> bool:
    """Return whether *repository_name* has an image tagged *tag*."""
    try:
        response = ecr_client.describe_images(
            repositoryName=repository_name,
            imageIds=[{"imageTag": tag}],
        )
    except ClientError as error:
        if is_image_not_found_error(error):
            return False
        raise
    image_details = response.get("imageDetails") or []
    return bool(image_details)


def require_customer_computer_image(
    ecr_client: EcrImageCatalogClient,
    *,
    repository_uri: str,
    tag: str = DEV_IMAGE_TAG,
) -> str:
    """Refuse when the customer repository does not yet have *tag*."""
    repository_name = repository_name_from_uri(repository_uri)
    if customer_image_tag_exists(
        ecr_client,
        repository_name=repository_name,
        tag=tag,
    ):
        return f"{repository_uri}:{tag}"
    msg = (
        f"Customer computer image tag {tag!r} is missing from repository "
        f"{repository_name!r}; publish :dev to the organization AWS home "
        "before starting a host."
    )
    raise OrganizationComputerProvisioningError(msg)


def publish_dev_image_from_anthus(
    anthus_ecr_client: EcrImageCatalogClient,
    customer_ecr_client: EcrImageCatalogClient,
    *,
    anthus_repository_name: str,
    customer_repository_name: str,
    tag: str = DEV_IMAGE_TAG,
) -> str:
    """Copy one tagged image from Anthus ECR into a customer repository."""
    response = anthus_ecr_client.batch_get_image(
        repositoryName=anthus_repository_name,
        imageIds=[{"imageTag": tag}],
    )
    failures = response.get("failures") or []
    if failures:
        msg = (
            f"Anthus repository {anthus_repository_name!r} has no tag {tag!r}; "
            f"batch_get_image failures={failures!r}."
        )
        raise OrganizationComputerProvisioningError(msg)
    images = response.get("images") or []
    if not images:
        msg = f"Anthus repository {anthus_repository_name!r} has no tag {tag!r}."
        raise OrganizationComputerProvisioningError(msg)
    image_manifest = images[0].get("imageManifest")
    if not isinstance(image_manifest, str) or not image_manifest:
        msg = (
            f"Anthus repository {anthus_repository_name!r} returned no manifest "
            f"for tag {tag!r}."
        )
        raise OrganizationComputerProvisioningError(msg)
    customer_ecr_client.put_image(
        repositoryName=customer_repository_name,
        imageManifest=image_manifest,
        imageTag=tag,
    )
    return tag


def is_image_not_found_error(error: ClientError) -> bool:
    """Return whether *error* means the requested image tag does not exist."""
    code = str(error.response.get("Error", {}).get("Code", ""))
    return code in {"ImageNotFoundException", "RepositoryNotFoundException"}
