/**
 * The AWS surface customer-account provisioning and host start use. Every call goes through these ports so tests
 * can fake the external system; the real SDK clients are wrapped in aws-clients.ts. Shapes follow the AWS wire
 * names, as the boto3 calls they replace did.
 */

/** An AWS API call failed; the message is formatted the way boto3 formats a ClientError. */
export class AwsApiError extends Error {
	readonly code: string;
	readonly awsMessage: string;
	readonly operation: string;

	constructor(code: string, awsMessage: string, operation: string) {
		super(`An error occurred (${code}) when calling the ${operation} operation: ${awsMessage}`);
		this.name = "AwsApiError";
		this.code = code;
		this.awsMessage = awsMessage;
		this.operation = operation;
	}
}

/** One stack output. */
export interface StackOutputEntry {
	OutputKey?: string;
	OutputValue?: string;
}

/** One stack as DescribeStacks returns it. */
export interface StackDescription {
	StackStatus?: string;
	Outputs?: StackOutputEntry[];
}

/** The DescribeStacks response. */
export interface DescribeStacksResponse {
	Stacks?: StackDescription[];
}

/** One CloudFormation stack parameter. */
export interface StackParameter {
	ParameterKey: string;
	ParameterValue: string;
}

/** CreateStack and UpdateStack input; the template travels as a body or as a URL. */
export interface StackWriteInput {
	StackName: string;
	Parameters: StackParameter[];
	Capabilities: string[];
	TemplateBody?: string;
	TemplateURL?: string;
}

/** The CloudFormation calls provisioning makes under an assumed role. */
export interface CloudFormationPort {
	describeStacks(input: { StackName: string }): Promise<DescribeStacksResponse>;
	createStack(input: StackWriteInput): Promise<unknown>;
	updateStack(input: StackWriteInput): Promise<unknown>;
	deleteStack(input: { StackName: string }): Promise<unknown>;
}

/** One ECS RunTask call for a Fargate computer host. */
export interface EcsRunTaskInput {
	cluster: string;
	taskDefinition: string;
	launchType: "FARGATE";
	networkConfiguration: {
		awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: "ENABLED" };
	};
	tags: Array<{ key: string; value: string }>;
	overrides?: {
		containerOverrides: Array<{
			name: string;
			command: string[];
			environment: Array<{ name: string; value: string }>;
		}>;
	};
}

/** The ECS call host start makes. */
export interface EcsPort {
	runTask(input: EcsRunTaskInput): Promise<{ tasks?: unknown[]; failures?: unknown[] }>;
}

/** The ECR calls the customer computer image check and publish make. */
export interface EcrPort {
	describeImages(input: { repositoryName: string; imageIds: Array<{ imageTag: string }> }): Promise<{ imageDetails?: unknown[] }>;
	batchGetImage(input: {
		repositoryName: string;
		imageIds: Array<{ imageTag: string }>;
	}): Promise<{ images?: Array<{ imageManifest?: string }>; failures?: unknown[] }>;
	putImage(input: { repositoryName: string; imageManifest: string; imageTag: string }): Promise<unknown>;
}

/** The short-lived credentials an AssumeRole call returns. */
export interface AssumedRoleCredentials {
	AccessKeyId: string;
	SecretAccessKey: string;
	SessionToken: string;
	Expiration: Date;
}

/** STS AssumeRole, the only way Chatticus reaches a customer account. */
export type AssumeRolePort = (input: {
	RoleArn: string;
	RoleSessionName: string;
	ExternalId: string;
}) => Promise<{ Credentials: AssumedRoleCredentials }>;

/** STS AssumeRole of a role of the deployment's own account, narrowed by an inline session policy and a lifetime. */
export type ScopedAssumeRolePort = (input: {
	RoleArn: string;
	RoleSessionName: string;
	/** The session policy as JSON text; the credentials get the intersection of it and the role's own permissions. */
	Policy: string;
	DurationSeconds: number;
}) => Promise<{ Credentials: AssumedRoleCredentials }>;

/** Credentials forwarded in process from an AssumeRole response; never stored. */
export interface SessionCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
}

/** The IAM reads role inspection makes under an assumed role. */
export interface IamPolicyReaderPort {
	listRolePolicies(input: { RoleName: string }): Promise<{ PolicyNames?: string[] }>;
	getRolePolicy(input: { RoleName: string; PolicyName: string }): Promise<{ PolicyDocument?: unknown }>;
}
