import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AwsApiError } from "../src/computer/aws-ports.ts";
import {
	customerComputerEcsConfigFromStackOutputs,
	parsePublicSubnetIds,
	stackHasRunTaskOutputs,
	stackOutputsFromDescribeStacks,
} from "../src/computer/customer-stack.ts";
import {
	CREATE_STACK_TEMPLATE_BYTE_LIMIT,
	createStackCapabilities,
	customerComputersCreateStackParameters,
	customerComputersTemplateBody,
	isNoStackUpdatesError,
	isStackMissingError,
	loadCustomerComputersTemplate,
	templateDeliveryForCreateStack,
} from "../src/computer/customer-template.ts";
import { repositoryNameFromUri } from "../src/computer/customer-image.ts";
import {
	AwsCrossAccountRoleInspector,
	CrossAccountRoleInspectionError,
	PROVISIONING_REQUIRED_PERMISSIONS,
	accountIdFromRoleArn,
	iamActionsFromPolicyDocument,
} from "../src/computer/provisioning.ts";
import {
	BUCKET_NAME_PREFIX,
	CustomerSnapshotBucketNameError,
	customerSnapshotBucketName,
} from "../src/snapshot/customer-bucket.ts";

const ACCOUNT_ID = "123456789012";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/ChatticusOrganizationComputerRole`;
const TENANT_ID = "tenant-alpha";
const SAMPLE_ORGANIZATION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const repositoryRoot = new URL("../../", import.meta.url);

function publishedInlinePolicy() {
	return {
		Version: "2012-10-17",
		Statement: [{ Effect: "Allow", Action: [...PROVISIONING_REQUIRED_PERMISSIONS], Resource: "*" }],
	};
}

const credentials = { Credentials: { AccessKeyId: "AKIA", SecretAccessKey: "secret", SessionToken: "token", Expiration: new Date(0) } };

describe("customer role template", () => {
	it("grants every permission the self-setup check requires", () => {
		const text = readFileSync(new URL("infra/customer-role.yml", repositoryRoot), "utf8");
		const missing = PROVISIONING_REQUIRED_PERMISSIONS.filter((permission) => !text.includes(`'${permission}'`));
		expect(missing).toEqual([]);
	});
});

describe("customer computers template asset", () => {
	it("is the same artifact the CDK synth check guards until the Python copy is deleted", () => {
		const infraCopy = readFileSync(new URL("infra/assets/customer-computers-template.json", repositoryRoot), "utf8");
		const pythonCopy = readFileSync(new URL("python/src/chatticus/assets/customer-computers.template.json", repositoryRoot), "utf8");
		expect(infraCopy).toBe(pythonCopy);
	});

	it("is under the CreateStack body limit and carries no CDK bootstrap", () => {
		const body = customerComputersTemplateBody();
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(CREATE_STACK_TEMPLATE_BYTE_LIMIT);
		expect(body).not.toContain("AWS::S3::Bucket");
		expect(body).toContain("CHATTICUS_SNAPSHOT_BUCKET");
		expect(body).toContain("AWS::ECR::Repository");
		expect(body).not.toContain("AWS::SSM::Parameter::Value");
		expect(body).not.toContain("/cdk-bootstrap/");
		const template = loadCustomerComputersTemplate();
		expect(Object.keys(template.Parameters).sort()).toEqual(["SnapshotBucketName", "TenantId"]);
		expect(Object.keys(template.Outputs)).toEqual(expect.arrayContaining(["ComputerPublicSubnetIds", "ComputerSecurityGroupId"]));
	});
});

describe("template helpers", () => {
	it("asks for the IAM capabilities", () => {
		expect(createStackCapabilities()).toEqual(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);
	});

	it("recognises a missing stack and a no-op update", () => {
		expect(isStackMissingError(new AwsApiError("ValidationError", "does not exist", "DescribeStacks"))).toBe(true);
		expect(isStackMissingError(new AwsApiError("AccessDenied", "nope", "DescribeStacks"))).toBe(false);
		expect(isNoStackUpdatesError(new AwsApiError("ValidationError", "No updates are to be performed.", "UpdateStack"))).toBe(true);
		expect(isNoStackUpdatesError(new AwsApiError("AccessDenied", "nope", "UpdateStack"))).toBe(false);
	});

	it("delivers a template by body under the limit and by URL over it", () => {
		const body = "x".repeat(CREATE_STACK_TEMPLATE_BYTE_LIMIT);
		expect(templateDeliveryForCreateStack(body)).toEqual({ TemplateBody: body });
		const large = "x".repeat(CREATE_STACK_TEMPLATE_BYTE_LIMIT + 1);
		expect(templateDeliveryForCreateStack(large, { templateUrl: "https://example-bucket.s3.amazonaws.com/template.json" })).toEqual({
			TemplateURL: "https://example-bucket.s3.amazonaws.com/template.json",
		});
		expect(() => templateDeliveryForCreateStack(large)).toThrow(/no template URL/);
	});

	it("passes the tenant and its snapshot bucket as stack parameters", () => {
		expect(customerComputersCreateStackParameters({ tenantId: "tenant-1" })).toEqual([
			{ ParameterKey: "TenantId", ParameterValue: "tenant-1" },
			{ ParameterKey: "SnapshotBucketName", ParameterValue: "chatticus-snapshots-tenant-1" },
		]);
	});
});

describe("stack outputs", () => {
	const complete = {
		ComputerClusterName: "cluster-a",
		ComputerTaskDefinitionArn: "arn:task/computer:1",
		ComputerPublicSubnetIds: "subnet-1,subnet-2",
		ComputerSecurityGroupId: "sg-1",
		ComputerRepositoryUri: `${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage`,
	};

	it("reads outputs from a DescribeStacks response", () => {
		const outputs = stackOutputsFromDescribeStacks({
			Stacks: [{ Outputs: [{ OutputKey: "ComputerClusterName", OutputValue: "cluster-a" }, { OutputKey: "", OutputValue: "x" }] }],
		});
		expect(outputs).toEqual({ ComputerClusterName: "cluster-a" });
		expect(stackOutputsFromDescribeStacks({})).toEqual({});
	});

	it("splits subnets and requires every RunTask output", () => {
		expect(parsePublicSubnetIds("subnet-1,subnet-2")).toEqual(["subnet-1", "subnet-2"]);
		expect(parsePublicSubnetIds("")).toEqual([]);
		expect(stackHasRunTaskOutputs(complete)).toBe(true);
		const { ComputerRepositoryUri: _omitted, ...withoutRepository } = complete;
		expect(stackHasRunTaskOutputs(withoutRepository)).toBe(false);
	});

	it("builds the ECS config or refuses an incomplete stack", () => {
		expect(customerComputerEcsConfigFromStackOutputs(complete)).toEqual({
			cluster: "cluster-a",
			taskDefinition: "arn:task/computer:1",
			subnets: ["subnet-1", "subnet-2"],
			securityGroups: ["sg-1"],
		});
		expect(() => customerComputerEcsConfigFromStackOutputs({ ComputerClusterName: "cluster-a" })).toThrow(/incomplete/);
	});
});

describe("snapshot bucket naming", () => {
	it("lowercases the organization id", () => {
		expect(customerSnapshotBucketName(SAMPLE_ORGANIZATION_ID)).toBe(`${BUCKET_NAME_PREFIX}${SAMPLE_ORGANIZATION_ID}`);
		expect(customerSnapshotBucketName(SAMPLE_ORGANIZATION_ID.toUpperCase())).toBe(`${BUCKET_NAME_PREFIX}${SAMPLE_ORGANIZATION_ID}`);
	});

	it("rejects an empty, malformed or too long id", () => {
		expect(() => customerSnapshotBucketName("")).toThrow(CustomerSnapshotBucketNameError);
		expect(() => customerSnapshotBucketName("bad org id")).toThrow(/not a valid/);
		expect(() => customerSnapshotBucketName("x".repeat(50))).toThrow(/exceeds/);
	});
});

describe("repository names", () => {
	it("takes the last segment of the URI", () => {
		expect(repositoryNameFromUri(`${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage/`)).toBe(
			"chatticuscomputers-computerimage",
		);
	});
});

describe("role ARNs and policy documents", () => {
	it("extracts the account id of a valid role ARN only", () => {
		expect(accountIdFromRoleArn(ROLE_ARN)).toBe(ACCOUNT_ID);
		expect(accountIdFromRoleArn("arn:aws:iam::12345:role/x")).toBeNull();
		expect(accountIdFromRoleArn("not-an-arn")).toBeNull();
	});

	it("reads Allow actions from an object or a JSON string, ignoring Deny", () => {
		expect(iamActionsFromPolicyDocument(publishedInlinePolicy())).toEqual(new Set(PROVISIONING_REQUIRED_PERMISSIONS));
		expect(iamActionsFromPolicyDocument(JSON.stringify(publishedInlinePolicy()))).toEqual(new Set(PROVISIONING_REQUIRED_PERMISSIONS));
		expect(iamActionsFromPolicyDocument({ Statement: { Effect: "Deny", Action: "s3:*" } })).toEqual(new Set());
		expect(iamActionsFromPolicyDocument("not json")).toEqual(new Set());
	});
});

describe("the live role inspector", () => {
	function inspectorReading(policyDocument: unknown, calls: string[] = []) {
		return new AwsCrossAccountRoleInspector({
			assumeRole: async (input) => {
				calls.push("assumeRole");
				expect(input.ExternalId).toBe(TENANT_ID);
				return credentials;
			},
			iamPolicyReader: () => ({
				listRolePolicies: async (input) => {
					calls.push("listRolePolicies");
					expect(input.RoleName).toBe("ChatticusOrganizationComputerRole");
					return { PolicyNames: ["ChatticusProvisioningAndOperation"] };
				},
				getRolePolicy: async () => {
					calls.push("getRolePolicy");
					return { PolicyDocument: policyDocument };
				},
			}),
		});
	}

	it("assumes the role with the organization id and reads only the inline policies", async () => {
		const calls: string[] = [];
		const snapshot = await inspectorReading(publishedInlinePolicy(), calls).inspectRole(ACCOUNT_ID, ROLE_ARN, { expectedExternalId: TENANT_ID });
		expect(calls).toEqual(["assumeRole", "listRolePolicies", "getRolePolicy"]);
		expect(snapshot.trustedExternalId).toBe(TENANT_ID);
		expect(snapshot.grantedPermissions).toEqual(new Set(PROVISIONING_REQUIRED_PERMISSIONS));
	});

	it("reports an assume failure as an inspection error that names the organization id", async () => {
		const inspector = new AwsCrossAccountRoleInspector({
			assumeRole: async () => {
				throw new AwsApiError("AccessDenied", "AccessDenied", "AssumeRole");
			},
		});
		await expect(inspector.inspectRole(ACCOUNT_ID, ROLE_ARN, { expectedExternalId: TENANT_ID })).rejects.toThrow(
			CrossAccountRoleInspectionError,
		);
		await expect(inspector.inspectRole(ACCOUNT_ID, ROLE_ARN, { expectedExternalId: TENANT_ID })).rejects.toThrow(/OrganizationId/);
	});

	it("reports a policy read failure as an inspection error", async () => {
		const inspector = new AwsCrossAccountRoleInspector({
			assumeRole: async () => credentials,
			iamPolicyReader: () => ({
				listRolePolicies: async () => {
					throw new AwsApiError("AccessDenied", "AccessDenied", "ListRolePolicies");
				},
				getRolePolicy: async () => ({}),
			}),
		});
		await expect(inspector.inspectRole(ACCOUNT_ID, ROLE_ARN, { expectedExternalId: TENANT_ID })).rejects.toThrow(/could not be inspected/);
	});
});
