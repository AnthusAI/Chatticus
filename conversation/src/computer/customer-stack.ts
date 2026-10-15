/**
 * The customer-account ChatticusComputers stack: output parsing and the provisioners that create, update or
 * recover it under an assumed role.
 * Ported from python/src/chatticus/customer_computers_stack.py lines 1-94 and
 * python/src/chatticus/customer_computers_provision.py lines 1-282.
 */

import { OrganizationComputerProvisioningError } from "../http/errors.ts";
import type { Organization } from "../domain/organizations.ts";
import {
	AwsApiError,
	type CloudFormationPort,
	type DescribeStacksResponse,
	type StackWriteInput,
} from "./aws-ports.ts";
import {
	createStackCapabilities,
	customerComputersCreateStackParameters,
	customerComputersTemplateBody,
	isNoStackUpdatesError,
	isStackMissingError,
	templateDeliveryForCreateStack,
} from "./customer-template.ts";

export const COMPUTERS_STACK_NAME = "ChatticusComputers";
export const COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT = "ComputerPublicSubnetIds";
export const COMPUTER_SECURITY_GROUP_ID_OUTPUT = "ComputerSecurityGroupId";
export const COMPUTER_REPOSITORY_URI_OUTPUT = "ComputerRepositoryUri";

/** ECS wiring for one organization's ChatticusComputers stack. */
export interface CustomerComputerEcsConfig {
	cluster: string;
	taskDefinition: string;
	subnets: string[];
	securityGroups: string[];
}

/** The stack outputs do not carry the RunTask wiring. */
export class CustomerStackOutputsIncompleteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomerStackOutputsIncompleteError";
	}
}

/** Split one comma-separated public subnet output into subnet ids. */
export function parsePublicSubnetIds(subnetCsv: string): string[] {
	return subnetCsv
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

/** Return subnet ids and security group ids from stack outputs. */
export function networkFromStackOutputs(outputs: Readonly<Record<string, string>>): {
	subnets: string[];
	securityGroups: string[];
} {
	const subnets = parsePublicSubnetIds(outputs[COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT] ?? "");
	const securityGroup = (outputs[COMPUTER_SECURITY_GROUP_ID_OUTPUT] ?? "").trim();
	return { subnets, securityGroups: securityGroup === "" ? [] : [securityGroup] };
}

/** Return whether `outputs` include RunTask wiring from the committed template. */
export function stackHasRunTaskOutputs(outputs: Readonly<Record<string, string>>): boolean {
	const cluster = (outputs.ComputerClusterName ?? "").trim();
	const taskDefinition = (outputs.ComputerTaskDefinitionArn ?? "").trim();
	const repositoryUri = (outputs[COMPUTER_REPOSITORY_URI_OUTPUT] ?? "").trim();
	const { subnets, securityGroups } = networkFromStackOutputs(outputs);
	return (
		cluster !== "" &&
		taskDefinition !== "" &&
		subnets.length > 0 &&
		securityGroups.length > 0 &&
		repositoryUri !== ""
	);
}

function optionalOutputText(value: string | undefined): string {
	return value === undefined ? "None" : JSON.stringify(value);
}

/** Build ECS config from CloudFormation outputs. */
export function customerComputerEcsConfigFromStackOutputs(
	outputs: Readonly<Record<string, string>>,
): CustomerComputerEcsConfig {
	const cluster = (outputs.ComputerClusterName ?? "").trim();
	const taskDefinition = (outputs.ComputerTaskDefinitionArn ?? "").trim();
	const { subnets, securityGroups } = networkFromStackOutputs(outputs);
	if (cluster === "" || taskDefinition === "" || subnets.length === 0) {
		throw new CustomerStackOutputsIncompleteError(
			`${COMPUTERS_STACK_NAME} stack outputs are incomplete: cluster=${JSON.stringify(cluster)} ` +
				`task_definition=${JSON.stringify(taskDefinition)} subnets=${JSON.stringify(subnets)} ` +
				`${COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT}=${optionalOutputText(outputs[COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT])} ` +
				`${COMPUTER_SECURITY_GROUP_ID_OUTPUT}=${optionalOutputText(outputs[COMPUTER_SECURITY_GROUP_ID_OUTPUT])}`,
		);
	}
	return { cluster, taskDefinition, subnets: [...subnets], securityGroups: [...securityGroups] };
}

/** Extract output key/value pairs from one DescribeStacks response. */
export function stackOutputsFromDescribeStacks(response: DescribeStacksResponse): Record<string, string> {
	const stacks = response.Stacks ?? [];
	if (stacks.length === 0) {
		return {};
	}
	const outputs: Record<string, string> = {};
	for (const item of stacks[0]?.Outputs ?? []) {
		if (typeof item.OutputKey === "string" && typeof item.OutputValue === "string" && item.OutputKey !== "") {
			outputs[item.OutputKey] = item.OutputValue;
		}
	}
	return outputs;
}

export const TERMINAL_FAILED_RECOVERABLE_STATUSES: ReadonlySet<string> = new Set([
	"ROLLBACK_FAILED",
	"ROLLBACK_COMPLETE",
	"CREATE_FAILED",
	"DELETE_FAILED",
]);

export const UPDATE_IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
	"UPDATE_IN_PROGRESS",
	"UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
]);

export const UPDATE_ROLLBACK_IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
	"UPDATE_ROLLBACK_IN_PROGRESS",
	"UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
]);

export const READY_STACK_STATUSES: ReadonlySet<string> = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);

/** Return whether `status` should trigger DeleteStack before recreate. */
export function isRecoverableTerminalFailedStatus(status: string): boolean {
	return TERMINAL_FAILED_RECOVERABLE_STATUSES.has(status);
}

/** Ensure one organization's ChatticusComputers stack exists. */
export interface CustomerComputersProvisioner {
	/** Create or wait for the customer ChatticusComputers stack. */
	ensureStack(cloudformation: CloudFormationPort, organization: Organization): Promise<void>;
}

/** Test double that refuses when the stack is missing. */
export class RefusingCustomerComputersProvisioner implements CustomerComputersProvisioner {
	/** Raise when ChatticusComputers is absent. */
	async ensureStack(cloudformation: CloudFormationPort, _organization: Organization): Promise<void> {
		try {
			await cloudformation.describeStacks({ StackName: COMPUTERS_STACK_NAME });
		} catch (error) {
			if (!(error instanceof AwsApiError)) {
				throw error;
			}
			if (isStackMissingError(error)) {
				throw new OrganizationComputerProvisioningError(
					`${COMPUTERS_STACK_NAME} stack does not exist in the organization AWS home.`,
				);
			}
			throw new OrganizationComputerProvisioningError(`DescribeStacks(${COMPUTERS_STACK_NAME}) failed: ${error.message}`);
		}
	}
}

/** Create or poll customer ChatticusComputers under an assumed role session. */
export class AwsCustomerComputersProvisioner implements CustomerComputersProvisioner {
	private readonly templateUrl: string | null;

	constructor(options: { templateUrl?: string | null } = {}) {
		this.templateUrl = options.templateUrl ?? null;
	}

	/** Create, update, or wait for ChatticusComputers in the customer account. */
	async ensureStack(cloudformation: CloudFormationPort, organization: Organization): Promise<void> {
		let { status, outputs } = await this.describeStack(cloudformation);
		if (status === null) {
			await this.startCreateStack(cloudformation, organization);
			({ status, outputs } = await this.describeStack(cloudformation));
			if (status === null) {
				throw new OrganizationComputerProvisioningError(
					`${COMPUTERS_STACK_NAME} stack create started in the organization AWS home.`,
				);
			}
		}
		if (status === "CREATE_IN_PROGRESS" || status === "REVIEW_IN_PROGRESS") {
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack provisioning is still in progress (${status}).`,
			);
		}
		if (status === "ROLLBACK_IN_PROGRESS" || status === "DELETE_IN_PROGRESS") {
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack is ${status}; computer start refused.`,
			);
		}
		if (UPDATE_IN_PROGRESS_STATUSES.has(status)) {
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack update is still in progress (${status}); computer start refused.`,
			);
		}
		if (UPDATE_ROLLBACK_IN_PROGRESS_STATUSES.has(status)) {
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack update rollback is in progress (${status}); computer start refused.`,
			);
		}
		if (isRecoverableTerminalFailedStatus(status)) {
			await this.startDeleteStack(cloudformation);
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack is ${status}; delete started, computer start refused.`,
			);
		}
		if (READY_STACK_STATUSES.has(status)) {
			if (stackHasRunTaskOutputs(outputs)) {
				return;
			}
			if (status === "UPDATE_COMPLETE") {
				throw new OrganizationComputerProvisioningError(
					`${COMPUTERS_STACK_NAME} stack outputs are incomplete; computer start refused.`,
				);
			}
			await this.startUpdateStack(cloudformation, organization);
			({ status, outputs } = await this.describeStack(cloudformation));
			if (status !== null && UPDATE_IN_PROGRESS_STATUSES.has(status)) {
				throw new OrganizationComputerProvisioningError(
					`${COMPUTERS_STACK_NAME} stack update started in the organization AWS home; computer start refused.`,
				);
			}
			if (status !== null && UPDATE_ROLLBACK_IN_PROGRESS_STATUSES.has(status)) {
				throw new OrganizationComputerProvisioningError(
					`${COMPUTERS_STACK_NAME} stack update rollback is in progress (${status}); computer start refused.`,
				);
			}
			if (status !== null && READY_STACK_STATUSES.has(status) && stackHasRunTaskOutputs(outputs)) {
				return;
			}
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack outputs are incomplete after template update; computer start refused.`,
			);
		}
		throw new OrganizationComputerProvisioningError(
			`${COMPUTERS_STACK_NAME} stack is ${status}; computer start refused.`,
		);
	}

	private async describeStack(
		cloudformation: CloudFormationPort,
	): Promise<{ status: string | null; outputs: Record<string, string> }> {
		let response: DescribeStacksResponse;
		try {
			response = await cloudformation.describeStacks({ StackName: COMPUTERS_STACK_NAME });
		} catch (error) {
			if (!(error instanceof AwsApiError)) {
				throw error;
			}
			if (isStackMissingError(error)) {
				return { status: null, outputs: {} };
			}
			throw new OrganizationComputerProvisioningError(`DescribeStacks(${COMPUTERS_STACK_NAME}) failed: ${error.message}`);
		}
		const stacks = response.Stacks ?? [];
		if (stacks.length === 0) {
			return { status: null, outputs: {} };
		}
		const rawStatus = stacks[0]?.StackStatus;
		const status = rawStatus === undefined ? null : String(rawStatus);
		return { status, outputs: stackOutputsFromDescribeStacks(response) };
	}

	private stackWriteInput(organization: Organization): StackWriteInput {
		return {
			StackName: COMPUTERS_STACK_NAME,
			Parameters: customerComputersCreateStackParameters({ tenantId: organization.tenantId }),
			Capabilities: createStackCapabilities(),
			...templateDeliveryForCreateStack(customerComputersTemplateBody(), { templateUrl: this.templateUrl }),
		};
	}

	private async startCreateStack(cloudformation: CloudFormationPort, organization: Organization): Promise<void> {
		try {
			await cloudformation.createStack(this.stackWriteInput(organization));
		} catch (error) {
			if (!(error instanceof AwsApiError)) {
				throw error;
			}
			if (error.code === "AlreadyExistsException") {
				return;
			}
			throw new OrganizationComputerProvisioningError(`CreateStack(${COMPUTERS_STACK_NAME}) failed: ${error.message}`);
		}
	}

	private async startUpdateStack(cloudformation: CloudFormationPort, organization: Organization): Promise<void> {
		try {
			await cloudformation.updateStack(this.stackWriteInput(organization));
		} catch (error) {
			if (!(error instanceof AwsApiError)) {
				throw error;
			}
			if (isNoStackUpdatesError(error)) {
				return;
			}
			throw new OrganizationComputerProvisioningError(`UpdateStack(${COMPUTERS_STACK_NAME}) failed: ${error.message}`);
		}
	}

	private async startDeleteStack(cloudformation: CloudFormationPort): Promise<void> {
		try {
			await cloudformation.deleteStack({ StackName: COMPUTERS_STACK_NAME });
		} catch (error) {
			if (!(error instanceof AwsApiError)) {
				throw error;
			}
			throw new OrganizationComputerProvisioningError(
				`DeleteStack(${COMPUTERS_STACK_NAME}) failed; computer start refused: ${error.message}`,
			);
		}
	}
}

/** Describe one customer ChatticusComputers stack or raise a provisioning error. */
export async function describeCustomerComputersStack(
	cloudformation: CloudFormationPort,
	stackName: string = COMPUTERS_STACK_NAME,
): Promise<DescribeStacksResponse> {
	try {
		return await cloudformation.describeStacks({ StackName: stackName });
	} catch (error) {
		if (!(error instanceof AwsApiError)) {
			throw error;
		}
		if (isStackMissingError(error)) {
			throw new OrganizationComputerProvisioningError(`${stackName} stack does not exist in the organization AWS home.`);
		}
		throw new OrganizationComputerProvisioningError(`DescribeStacks(${stackName}) failed: ${error.message}`);
	}
}
