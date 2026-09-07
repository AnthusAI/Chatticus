"""Provision customer-account ChatticusComputers stacks under AssumeRole."""

from __future__ import annotations

from typing import Any, Protocol

from botocore.exceptions import ClientError

from chatticus.customer_computers_stack import COMPUTERS_STACK_NAME
from chatticus.customer_computers_template import (
    create_stack_capabilities,
    customer_computers_create_stack_parameters,
    customer_computers_template_body,
    is_stack_missing_error,
    template_delivery_for_create_stack,
)
from chatticus.models import Organization, OrganizationComputerProvisioningError


class CustomerComputersProvisioner(Protocol):
    """Ensure one organization's ChatticusComputers stack exists."""

    def ensure_stack(
        self,
        cloudformation_client: Any,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> None:
        """Create or wait for the customer ChatticusComputers stack."""


class RefusingCustomerComputersProvisioner:
    """Test double that refuses when the stack is missing."""

    def ensure_stack(
        self,
        cloudformation_client: Any,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> None:
        """Raise when ChatticusComputers is absent."""
        try:
            cloudformation_client.describe_stacks(StackName=COMPUTERS_STACK_NAME)
        except ClientError as error:
            if is_stack_missing_error(error):
                msg = (
                    f"{COMPUTERS_STACK_NAME} stack does not exist in the "
                    "organization AWS home."
                )
                raise OrganizationComputerProvisioningError(msg) from error
            raise OrganizationComputerProvisioningError(
                f"DescribeStacks({COMPUTERS_STACK_NAME}) failed: {error}"
            ) from error


class AwsCustomerComputersProvisioner:
    """Create or poll customer ChatticusComputers under an assumed role session."""

    def __init__(
        self,
        *,
        template_url: str | None = None,
    ) -> None:
        self._template_url = template_url

    def ensure_stack(
        self,
        cloudformation_client: Any,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> None:
        """Create or wait for ChatticusComputers in the customer account."""
        status = self._stack_status(cloudformation_client)
        if status is None:
            self._start_create_stack(
                cloudformation_client,
                organization,
                anthus_computer_image_uri=anthus_computer_image_uri,
            )
            status = self._stack_status(cloudformation_client)
            if status is None:
                msg = (
                    f"{COMPUTERS_STACK_NAME} stack create started in the "
                    "organization AWS home."
                )
                raise OrganizationComputerProvisioningError(msg)
        if status in {"CREATE_IN_PROGRESS", "REVIEW_IN_PROGRESS"}:
            msg = (
                f"{COMPUTERS_STACK_NAME} stack provisioning is still in progress "
                f"({status})."
            )
            raise OrganizationComputerProvisioningError(msg)
        if status in {"ROLLBACK_IN_PROGRESS", "DELETE_IN_PROGRESS"}:
            msg = f"{COMPUTERS_STACK_NAME} stack is {status}; computer start refused."
            raise OrganizationComputerProvisioningError(msg)
        if status.endswith("_FAILED") or status == "ROLLBACK_COMPLETE":
            msg = f"{COMPUTERS_STACK_NAME} stack is {status}; computer start refused."
            raise OrganizationComputerProvisioningError(msg)
        if status != "CREATE_COMPLETE":
            msg = f"{COMPUTERS_STACK_NAME} stack is {status}; computer start refused."
            raise OrganizationComputerProvisioningError(msg)

    def _stack_status(self, cloudformation_client: Any) -> str | None:
        try:
            response = cloudformation_client.describe_stacks(
                StackName=COMPUTERS_STACK_NAME
            )
        except ClientError as error:
            if is_stack_missing_error(error):
                return None
            raise OrganizationComputerProvisioningError(
                f"DescribeStacks({COMPUTERS_STACK_NAME}) failed: {error}"
            ) from error
        stacks = response.get("Stacks") or []
        if not stacks:
            return None
        status = stacks[0].get("StackStatus")
        return str(status) if status is not None else None

    def _start_create_stack(
        self,
        cloudformation_client: Any,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> None:
        template_body = customer_computers_template_body()
        delivery = template_delivery_for_create_stack(
            template_body,
            template_url=self._template_url,
        )
        try:
            cloudformation_client.create_stack(
                StackName=COMPUTERS_STACK_NAME,
                Parameters=customer_computers_create_stack_parameters(
                    tenant_id=organization.tenant_id,
                    anthus_computer_image_uri=anthus_computer_image_uri,
                ),
                Capabilities=create_stack_capabilities(),
                **delivery,
            )
        except ClientError as error:
            error_code = str(error.response.get("Error", {}).get("Code", ""))
            if error_code == "AlreadyExistsException":
                return
            raise OrganizationComputerProvisioningError(
                f"CreateStack({COMPUTERS_STACK_NAME}) failed: {error}"
            ) from error


def describe_customer_computers_stack(
    cloudformation_client: Any,
    *,
    stack_name: str = COMPUTERS_STACK_NAME,
) -> dict[str, Any]:
    """Describe one customer ChatticusComputers stack or raise a provisioning error."""
    try:
        return cloudformation_client.describe_stacks(StackName=stack_name)
    except ClientError as error:
        if is_stack_missing_error(error):
            msg = f"{stack_name} stack does not exist in the organization AWS home."
            raise OrganizationComputerProvisioningError(msg) from error
        raise OrganizationComputerProvisioningError(
            f"DescribeStacks({stack_name}) failed: {error}"
        ) from error
