import {
	AwsApiError,
	type AssumeRolePort,
	type CloudFormationPort,
	type DescribeStacksResponse,
	type EcrPort,
	type EcsPort,
	type EcsRunTaskInput,
	type SessionCredentials,
	type StackOutputEntry,
	type StackWriteInput,
} from "../../src/computer/aws-ports.ts";

export const CUSTOMER_ACCOUNT_ID = "123456789012";
export const CUSTOMER_COMPUTER_REPOSITORY_URI = `${CUSTOMER_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage`;
export const CUSTOMER_ROLE_ARN = `arn:aws:iam::${CUSTOMER_ACCOUNT_ID}:role/ChatticusOrganizationComputerRole`;
export const ASSUMED_ACCESS_KEY_ID = "AKIATEST";

/** STS AssumeRole stand-in: records every request and answers with fixed short-lived credentials. */
export class RecordingAssumeRole {
	readonly calls: Array<{ RoleArn: string; RoleSessionName: string; ExternalId: string }> = [];

	readonly port: AssumeRolePort = async (input) => {
		this.calls.push({ ...input });
		return {
			Credentials: {
				AccessKeyId: ASSUMED_ACCESS_KEY_ID,
				SecretAccessKey: "secret",
				SessionToken: "token",
				Expiration: new Date("2026-08-31T13:00:00Z"),
			},
		};
	};
}

/** STS AssumeRole stand-in for a customer role that cannot be assumed. */
export const unreachableAssumeRole: AssumeRolePort = async () => {
	throw new Error("AssumeRole refused by STS");
};

/** ECR stand-in holding the dev tag (or not) of one repository, and the images put into it. */
export class FakeEcr implements EcrPort {
	hasDevTag: boolean;
	readonly anthusManifest: string | null;
	readonly putImageCalls: Array<{ repositoryName: string; imageManifest: string; imageTag: string }> = [];

	constructor(options: { hasDevTag?: boolean; anthusManifest?: string | null } = {}) {
		this.hasDevTag = options.hasDevTag ?? true;
		this.anthusManifest = options.anthusManifest ?? null;
	}

	async describeImages(input: { repositoryName: string; imageIds: Array<{ imageTag: string }> }) {
		const tag = input.imageIds[0]?.imageTag;
		if (this.hasDevTag && tag === "dev") {
			return { imageDetails: [{ imageTags: ["dev"] }] };
		}
		throw new AwsApiError("ImageNotFoundException", `Images with tag ${tag} not found in repository`, "DescribeImages");
	}

	async batchGetImage(input: { repositoryName: string; imageIds: Array<{ imageTag: string }> }) {
		if (this.anthusManifest === null) {
			return { failures: [{ imageTag: input.imageIds[0]?.imageTag }] };
		}
		return { images: [{ imageManifest: this.anthusManifest }], failures: [] };
	}

	async putImage(input: { repositoryName: string; imageManifest: string; imageTag: string }) {
		this.putImageCalls.push({ ...input });
		this.hasDevTag = true;
		return {};
	}
}

/** ECS stand-in recording every RunTask. */
export class FakeEcs implements EcsPort {
	readonly calls: EcsRunTaskInput[] = [];

	async runTask(input: EcsRunTaskInput) {
		this.calls.push(input);
		return { tasks: [{ taskArn: "arn:ecs:task/gherkin" }], failures: [] };
	}
}

/** ECS in two accounts: the deployment account (no credentials) and the customer account (assumed credentials). */
export class MultiAccountEcsRecorder {
	readonly deployment = new FakeEcs();
	readonly customer = new FakeEcs();
	readonly deploymentClientsOpened: Array<SessionCredentials | null> = [];
	readonly customerClientsOpened: SessionCredentials[] = [];

	readonly factory = (credentials: SessionCredentials | null): EcsPort => {
		if (credentials === null) {
			this.deploymentClientsOpened.push(null);
			return this.deployment;
		}
		this.customerClientsOpened.push(credentials);
		return this.customer;
	};
}

const LEGACY_STACK_OUTPUTS: StackOutputEntry[] = [
	{ OutputKey: "ComputerClusterName", OutputValue: "cust-cluster" },
	{
		OutputKey: "ComputerTaskDefinitionArn",
		OutputValue: `arn:aws:ecs:us-east-1:${CUSTOMER_ACCOUNT_ID}:task-definition/computer:1`,
	},
	{ OutputKey: "ComputerServiceName", OutputValue: "FargateHost" },
];

const FULL_STACK_OUTPUTS: StackOutputEntry[] = [
	...LEGACY_STACK_OUTPUTS,
	{ OutputKey: "ComputerPublicSubnetIds", OutputValue: "subnet-customer-1,subnet-customer-2" },
	{ OutputKey: "ComputerSecurityGroupId", OutputValue: "sg-customer-1" },
	{ OutputKey: "ComputerRepositoryUri", OutputValue: CUSTOMER_COMPUTER_REPOSITORY_URI },
];

/** CloudFormation in a customer account: one ChatticusComputers stack with a status, outputs and recorded writes. */
export class FakeCloudFormation implements CloudFormationPort {
	stackPresent: boolean;
	stackStatus: string | null;
	readonly createResultStatus: string;
	deleteDenied: boolean;
	outputProfile: "full" | "legacy";
	updateNoOp: boolean;
	readonly describeCalls: Array<{ StackName: string }> = [];
	readonly createStackCalls: StackWriteInput[] = [];
	readonly updateStackCalls: StackWriteInput[] = [];
	readonly deleteStackCalls: Array<{ StackName: string }> = [];

	constructor(
		options: {
			stackPresent?: boolean;
			stackStatus?: string;
			createResultStatus?: string;
			deleteDenied?: boolean;
			outputProfile?: "full" | "legacy";
			updateNoOp?: boolean;
		} = {},
	) {
		this.stackPresent = options.stackPresent ?? true;
		this.stackStatus = this.stackPresent ? (options.stackStatus ?? "CREATE_COMPLETE") : null;
		this.createResultStatus = options.createResultStatus ?? "CREATE_COMPLETE";
		this.deleteDenied = options.deleteDenied ?? false;
		this.outputProfile = options.outputProfile ?? "full";
		this.updateNoOp = options.updateNoOp ?? false;
	}

	async describeStacks(input: { StackName: string }): Promise<DescribeStacksResponse> {
		this.describeCalls.push({ ...input });
		if (!this.stackPresent) {
			throw new AwsApiError("ValidationError", "Stack with id ChatticusComputers does not exist", "DescribeStacks");
		}
		const stack: { StackStatus: string; Outputs?: StackOutputEntry[] } = { StackStatus: this.stackStatus ?? "" };
		if (this.stackStatus === "CREATE_COMPLETE" || this.stackStatus === "UPDATE_COMPLETE") {
			stack.Outputs = this.outputProfile === "legacy" ? [...LEGACY_STACK_OUTPUTS] : [...FULL_STACK_OUTPUTS];
		}
		return { Stacks: [stack] };
	}

	async createStack(input: StackWriteInput) {
		this.createStackCalls.push(input);
		this.stackPresent = true;
		this.stackStatus = this.createResultStatus;
		if (this.createResultStatus === "CREATE_COMPLETE") {
			this.outputProfile = "full";
		}
		return { StackId: "arn:aws:cloudformation:stack/gherkin" };
	}

	async updateStack(input: StackWriteInput) {
		this.updateStackCalls.push(input);
		if (this.updateNoOp) {
			throw new AwsApiError("ValidationError", "No updates are to be performed.", "UpdateStack");
		}
		this.stackStatus = "UPDATE_IN_PROGRESS";
		return {};
	}

	async deleteStack(input: { StackName: string }) {
		if (this.deleteDenied) {
			throw new AwsApiError("AccessDenied", "DeleteStack denied", "DeleteStack");
		}
		this.deleteStackCalls.push({ ...input });
		this.stackStatus = "DELETE_IN_PROGRESS";
		return {};
	}

	setStackMissing(): void {
		this.stackPresent = false;
		this.stackStatus = null;
	}

	setStackStatus(status: string): void {
		this.stackPresent = true;
		this.stackStatus = status;
		if (status === "CREATE_COMPLETE") {
			this.outputProfile = "full";
		}
	}

	finishStackUpdate(): void {
		this.stackPresent = true;
		this.stackStatus = "UPDATE_COMPLETE";
		this.outputProfile = "full";
	}
}
