"""Provision customer-account ChatticusComputers stacks under AssumeRole."""

from __future__ import annotations

from typing import Any, Protocol

from botocore.exceptions import ClientError

from chatticus.customer_computers_stack import (
    COMPUTERS_STACK_NAME,
    stack_has_run_task_outputs,
    stack_outputs_from_describe_stacks,
)
from chatticus.customer_computers_template import (
    create_stack_capabilities,
    customer_computers_create_stack_parameters,
    customer_computers_template_body,
    is_no_stack_updates_error,
    is_stack_missing_error,
    template_delivery_for_create_stack,
)
from chatticus.models import Organization, OrganizationComputerProvisioningError

TERMINAL_FAILED_RECOVERABLE_STATUSES: frozenset[str] = frozenset(
    {
        "ROLLBACK_FAILED",
        "ROLLBACK_COMPLETE",
        "CREATE_FAILED",
        "DELETE_FAILED",
    }
)

UPDATE_IN_PROGRESS_STATUSES: frozenset[str] = frozenset(
    {
        "UPDATE_IN_PROGRESS",
        "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
    }
)

UPDATE_ROLLBACK_IN_PROGRESS_STATUSES: frozenset[str] = frozenset(
    {
        "UPDATE_ROLLBACK_IN_PROGRESS",
        "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    }
)

READY_STACK_STATUSES: frozenset[str] = frozenset({"CREATE_COMPLETE", "UPDATE_COMPLETE"})


def is_recoverable_terminal_failed_status(status: str) -> bool:
    """Return whether *status* should trigger DeleteStack before recreate."""
    return status in TERMINAL_FAILED_RECOVERABLE_STATUSES


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
        """Create, update, or wait for ChatticusComputers in the customer account."""
        status, outputs = self._describe_stack(cloudformation_client)
        if status is None:
            self._start_create_stack(
                cloudformation_client,
                organization,
                anthus_computer_image_uri=anthus_computer_image_uri,
            )
            status, outputs = self._describe_stack(cloudformation_client)
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
        if status in UPDATE_IN_PROGRESS_STATUSES:
            msg = (
                f"{COMPUTERS_STACK_NAME} stack update is still in progress "
                f"({status}); computer start refused."
            )
            raise OrganizationComputerProvisioningError(msg)
        if status in UPDATE_ROLLBACK_IN_PROGRESS_STATUSES:
            msg = (
                f"{COMPUTERS_STACK_NAME} stack update rollback is in progress "
                f"({status}); computer start refused."
            )
            raise OrganizationComputerProvisioningError(msg)
        if is_recoverable_terminal_failed_status(status):
            self._start_delete_stack(cloudformation_client)
            msg = (
                f"{COMPUTERS_STACK_NAME} stack is {status}; delete started, "
                "computer start refused."
            )
            raise OrganizationComputerProvisioningError(msg)
        if status in READY_STACK_STATUSES:
            if stack_has_run_task_outputs(outputs):
                return
            if status == "UPDATE_COMPLETE":
                msg = (
                    f"{COMPUTERS_STACK_NAME} stack outputs are incomplete; "
                    "computer start refused."
                )
                raise OrganizationComputerProvisioningError(msg)
            self._start_update_stack(
                cloudformation_client,
                organization,
                anthus_computer_image_uri=anthus_computer_image_uri,
            )
            status, outputs = self._describe_stack(cloudformation_client)
            if status in UPDATE_IN_PROGRESS_STATUSES:
                msg = (
                    f"{COMPUTERS_STACK_NAME} stack update started in the "
                    "organization AWS home; computer start refused."
                )
                raise OrganizationComputerProvisioningError(msg)
            if status in UPDATE_ROLLBACK_IN_PROGRESS_STATUSES:
                msg = (
                    f"{COMPUTERS_STACK_NAME} stack update rollback is in progress "
                    f"({status}); computer start refused."
                )
                raise OrganizationComputerProvisioningError(msg)
            if status in READY_STACK_STATUSES and stack_has_run_task_outputs(outputs):
                return
            msg = (
                f"{COMPUTERS_STACK_NAME} stack outputs are incomplete after "
                "template update; computer start refused."
            )
            raise OrganizationComputerProvisioningError(msg)
        msg = f"{COMPUTERS_STACK_NAME} stack is {status}; computer start refused."
        raise OrganizationComputerProvisioningError(msg)

    def _describe_stack(
        self,
        cloudformation_client: Any,
    ) -> tuple[str | None, dict[str, str]]:
        try:
            response = cloudformation_client.describe_stacks(
                StackName=COMPUTERS_STACK_NAME
            )
        except ClientError as error:
            if is_stack_missing_error(error):
                return None, {}
            raise OrganizationComputerProvisioningError(
                f"DescribeStacks({COMPUTERS_STACK_NAME}) failed: {error}"
            ) from error
        stacks = response.get("Stacks") or []
        if not stacks:
            return None, {}
        status = stacks[0].get("StackStatus")
        stack_status = str(status) if status is not None else None
        outputs = stack_outputs_from_describe_stacks(response)
        return stack_status, outputs

    def _stack_delivery(self) -> dict[str, str]:
        template_body = customer_computers_template_body()
        return template_delivery_for_create_stack(
            template_body,
            template_url=self._template_url,
        )

    def _stack_parameters(
        self,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> list[dict[str, str]]:
        return customer_computers_create_stack_parameters(
            tenant_id=organization.tenant_id,
            anthus_computer_image_uri=anthus_computer_image_uri,
        )

    def _start_create_stack(
        self,
        cloudformation_client: Any,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> None:
        try:
            cloudformation_client.create_stack(
                StackName=COMPUTERS_STACK_NAME,
                Parameters=self._stack_parameters(
                    organization,
                    anthus_computer_image_uri=anthus_computer_image_uri,
                ),
                Capabilities=create_stack_capabilities(),
                **self._stack_delivery(),
            )
        except ClientError as error:
            error_code = str(error.response.get("Error", {}).get("Code", ""))
            if error_code == "AlreadyExistsException":
                return
            raise OrganizationComputerProvisioningError(
                f"CreateStack({COMPUTERS_STACK_NAME}) failed: {error}"
            ) from error

    def _start_update_stack(
        self,
        cloudformation_client: Any,
        organization: Organization,
        *,
        anthus_computer_image_uri: str,
    ) -> None:
        try:
            cloudformation_client.update_stack(
                StackName=COMPUTERS_STACK_NAME,
                Parameters=self._stack_parameters(
                    organization,
                    anthus_computer_image_uri=anthus_computer_image_uri,
                ),
                Capabilities=create_stack_capabilities(),
                **self._stack_delivery(),
            )
        except ClientError as error:
            if is_no_stack_updates_error(error):
                return
            raise OrganizationComputerProvisioningError(
                f"UpdateStack({COMPUTERS_STACK_NAME}) failed: {error}"
            ) from error

    def _start_delete_stack(self, cloudformation_client: Any) -> None:
        try:
            cloudformation_client.delete_stack(StackName=COMPUTERS_STACK_NAME)
        except ClientError as error:
            raise OrganizationComputerProvisioningError(
                f"DeleteStack({COMPUTERS_STACK_NAME}) failed; "
                f"computer start refused: {error}"
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
