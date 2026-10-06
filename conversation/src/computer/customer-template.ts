/**
 * Helpers for the customer ChatticusComputers CloudFormation template.
 * Ported from python/src/chatticus/customer_computers_template.py lines 1-84.
 */

import customerComputersTemplateAsset from "../../../infra/assets/customer-computers-template.json" with { type: "json" };
import { customerSnapshotBucketName } from "../snapshot/customer-bucket.ts";
import { AwsApiError, type StackParameter } from "./aws-ports.ts";

export const CREATE_STACK_TEMPLATE_BYTE_LIMIT = 51_200;

export const CREATE_STACK_CAPABILITIES = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] as const;

/** Return IAM capabilities required for customer ChatticusComputers. */
export function createStackCapabilities(): string[] {
	return [...CREATE_STACK_CAPABILITIES];
}

/** Return whether `error` means the ChatticusComputers stack does not exist. */
export function isStackMissingError(error: unknown): boolean {
	if (!(error instanceof AwsApiError)) {
		return false;
	}
	if (error.code === "ValidationError" || error.code === "ResourceNotFoundException") {
		return true;
	}
	return error.awsMessage.toLowerCase().includes("does not exist");
}

/** Return whether CloudFormation rejected UpdateStack because nothing changed. */
export function isNoStackUpdatesError(error: unknown): boolean {
	if (!(error instanceof AwsApiError)) {
		return false;
	}
	return error.awsMessage.toLowerCase().includes("no updates are to be performed");
}

/** Choose TemplateBody or TemplateURL for one CreateStack call. */
export function templateDeliveryForCreateStack(
	templateBody: string,
	options: { templateUrl?: string | null; byteLimit?: number } = {},
): { TemplateBody: string } | { TemplateURL: string } {
	const byteLimit = options.byteLimit ?? CREATE_STACK_TEMPLATE_BYTE_LIMIT;
	const encodedLength = Buffer.byteLength(templateBody, "utf8");
	if (encodedLength <= byteLimit) {
		return { TemplateBody: templateBody };
	}
	if (!options.templateUrl) {
		throw new Error(
			`Customer ChatticusComputers template is ${encodedLength} bytes; limit is ${byteLimit} and no template URL was configured.`,
		);
	}
	return { TemplateURL: options.templateUrl };
}

/** Load the committed customer ChatticusComputers CloudFormation template. */
export function loadCustomerComputersTemplate(): Record<string, any> {
	return customerComputersTemplateAsset as Record<string, any>;
}

/** Return the customer template as a JSON string for CreateStack. */
export function customerComputersTemplateBody(): string {
	return JSON.stringify(loadCustomerComputersTemplate());
}

/** Build CloudFormation parameters for one customer ChatticusComputers stack. */
export function customerComputersCreateStackParameters(options: { tenantId: string }): StackParameter[] {
	return [
		{ ParameterKey: "TenantId", ParameterValue: options.tenantId },
		{ ParameterKey: "SnapshotBucketName", ParameterValue: customerSnapshotBucketName(options.tenantId) },
	];
}
