/**
 * The real AWS SDK clients behind the ports in aws-ports.ts. Customer-account clients are built from credentials
 * forwarded in process from an AssumeRole response; nothing here stores or mints a long-lived credential.
 * Ported from the boto3 defaults in python/src/chatticus/organization_computer_host.py lines 281-302 and
 * python/src/chatticus/cross_account_provisioning.py lines 130-175.
 */

import {
	CloudFormationClient,
	CreateStackCommand,
	DeleteStackCommand,
	DescribeStacksCommand,
	UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { BatchGetImageCommand, DescribeImagesCommand, ECRClient, PutImageCommand } from "@aws-sdk/client-ecr";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { GetRolePolicyCommand, IAMClient, ListRolePoliciesCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
	AwsApiError,
	type AssumeRolePort,
	type CloudFormationPort,
	type EcrPort,
	type EcsPort,
	type IamPolicyReaderPort,
	type ScopedAssumeRolePort,
	type SessionCredentials,
} from "./aws-ports.ts";

async function callAws<T>(operation: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof Error && typeof (error as { $fault?: unknown }).$fault === "string") {
			throw new AwsApiError(error.name, error.message, operation);
		}
		throw error;
	}
}

function clientCredentials(credentials: SessionCredentials | null) {
	return credentials === null ? {} : { credentials };
}

/** STS AssumeRole of a role of this account with a session policy, so the returned credentials reach only what the policy names. */
export const defaultScopedAssumeRole: ScopedAssumeRolePort = async (input) => {
	const response = await callAws("AssumeRole", () =>
		new STSClient({}).send(
			new AssumeRoleCommand({
				RoleArn: input.RoleArn,
				RoleSessionName: input.RoleSessionName,
				Policy: input.Policy,
				DurationSeconds: input.DurationSeconds,
			}),
		),
	);
	const credentials = response.Credentials;
	if (
		credentials?.AccessKeyId === undefined ||
		credentials.SecretAccessKey === undefined ||
		credentials.SessionToken === undefined ||
		credentials.Expiration === undefined
	) {
		throw new AwsApiError("MalformedResponse", "AssumeRole returned no credentials.", "AssumeRole");
	}
	return {
		Credentials: {
			AccessKeyId: credentials.AccessKeyId,
			SecretAccessKey: credentials.SecretAccessKey,
			SessionToken: credentials.SessionToken,
			Expiration: credentials.Expiration,
		},
	};
};

/** STS AssumeRole with the deployment's own credentials. */
export const defaultAssumeRole: AssumeRolePort = async (input) => {
	const response = await callAws("AssumeRole", () =>
		new STSClient({}).send(
			new AssumeRoleCommand({
				RoleArn: input.RoleArn,
				RoleSessionName: input.RoleSessionName,
				ExternalId: input.ExternalId,
			}),
		),
	);
	const credentials = response.Credentials;
	if (
		credentials?.AccessKeyId === undefined ||
		credentials.SecretAccessKey === undefined ||
		credentials.SessionToken === undefined ||
		credentials.Expiration === undefined
	) {
		throw new AwsApiError("MalformedResponse", "AssumeRole returned no credentials.", "AssumeRole");
	}
	return {
		Credentials: {
			AccessKeyId: credentials.AccessKeyId,
			SecretAccessKey: credentials.SecretAccessKey,
			SessionToken: credentials.SessionToken,
			Expiration: credentials.Expiration,
		},
	};
};

/** IAM inline-policy reads under an assumed role; the SDK returns the policy document URL-encoded. */
export function defaultIamPolicyReader(credentials: SessionCredentials): IamPolicyReaderPort {
	const iam = new IAMClient({ credentials });
	return {
		listRolePolicies: async (input) => {
			const response = await callAws("ListRolePolicies", () => iam.send(new ListRolePoliciesCommand(input)));
			return { PolicyNames: response.PolicyNames };
		},
		getRolePolicy: async (input) => {
			const response = await callAws("GetRolePolicy", () => iam.send(new GetRolePolicyCommand(input)));
			const document = response.PolicyDocument;
			return { PolicyDocument: document === undefined ? undefined : decodeURIComponent(document) };
		},
	};
}

/** CloudFormation under the deployment's own credentials, or under an assumed role's. */
export function defaultCloudFormationClient(credentials: SessionCredentials | null): CloudFormationPort {
	const cloudformation = new CloudFormationClient(clientCredentials(credentials));
	return {
		describeStacks: (input) => callAws("DescribeStacks", () => cloudformation.send(new DescribeStacksCommand(input))),
		createStack: (input) =>
			callAws("CreateStack", () => cloudformation.send(new CreateStackCommand({ ...input, Capabilities: input.Capabilities as never }))),
		updateStack: (input) =>
			callAws("UpdateStack", () => cloudformation.send(new UpdateStackCommand({ ...input, Capabilities: input.Capabilities as never }))),
		deleteStack: (input) => callAws("DeleteStack", () => cloudformation.send(new DeleteStackCommand(input))),
	};
}

/** ECS under the deployment's own credentials, or under an assumed role's. */
export function defaultEcsClient(credentials: SessionCredentials | null): EcsPort {
	const ecs = new ECSClient(clientCredentials(credentials));
	return {
		runTask: (input) => callAws("RunTask", () => ecs.send(new RunTaskCommand(input))),
	};
}

/** ECR under the deployment's own credentials, or under an assumed role's. */
export function defaultEcrClient(credentials: SessionCredentials | null): EcrPort {
	const ecr = new ECRClient(clientCredentials(credentials));
	return {
		describeImages: (input) => callAws("DescribeImages", () => ecr.send(new DescribeImagesCommand(input))),
		batchGetImage: (input) => callAws("BatchGetImage", () => ecr.send(new BatchGetImageCommand(input))),
		putImage: (input) => callAws("PutImage", () => ecr.send(new PutImageCommand(input))),
	};
}
