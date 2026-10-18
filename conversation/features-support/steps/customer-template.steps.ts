import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Given, Then } from "@cucumber/cucumber";
import { parse as parseYaml } from "yaml";
import { loadCustomerComputersTemplate } from "../../src/computer/customer-template.ts";
import type { ChatticusWorld } from "../world.ts";

const CUSTOMER_ROLE_TEMPLATE_URL = new URL("../../../infra/customer-role.yml", import.meta.url);

const CLOUDFORMATION_SHORT_FORM_TAGS = ["Sub", "Ref", "GetAtt", "Join", "Select", "If", "Equals", "Not", "FindInMap", "Split", "Base64", "ImportValue"];

const cloudformationTags = CLOUDFORMATION_SHORT_FORM_TAGS.map((name) => ({
	tag: `!${name}`,
	resolve: (value: unknown) => ({ [name === "Ref" ? "Ref" : `Fn::${name}`]: value }),
}));

function customerRoleTemplate(world: ChatticusWorld): Record<string, any> {
	if (world.customerRoleTemplate === null) {
		world.customerRoleTemplate = parseYaml(readFileSync(CUSTOMER_ROLE_TEMPLATE_URL, "utf8"), { customTags: cloudformationTags });
	}
	return world.customerRoleTemplate as Record<string, any>;
}

function snapshotBucketResource(world: ChatticusWorld): Record<string, any> {
	const bucket = customerRoleTemplate(world).Resources?.OrganizationSnapshotBucket;
	assert.ok(bucket, "The template declares no OrganizationSnapshotBucket.");
	return bucket;
}

function crossAccountRoleStatements(world: ChatticusWorld): Array<Record<string, any>> {
	const role = customerRoleTemplate(world).Resources?.ChatticusCrossAccountRole;
	assert.equal(role?.Type, "AWS::IAM::Role", "The template declares no ChatticusCrossAccountRole.");
	const statements = (role.Properties?.Policies ?? []).flatMap((policy: any) => {
		const raw = policy.PolicyDocument?.Statement ?? [];
		return Array.isArray(raw) ? raw : [raw];
	});
	assert.ok(statements.length > 0, "The cross-account role grants nothing, so a denial would be vacuous.");
	return statements;
}

function grantedActions(statements: Array<Record<string, any>>): string[] {
	return statements
		.filter((statement) => statement.Effect === "Allow")
		.flatMap((statement) => (typeof statement.Action === "string" ? [statement.Action] : (statement.Action ?? []).map(String)));
}

function grantsAction(grants: string[], action: string): boolean {
	return grants.some((grant) => new RegExp(`^${grant.replaceAll("*", ".*")}$`).test(action));
}

function computersTemplate(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.customerComputersTemplate, "The committed customer ChatticusComputers template is not loaded.");
	return world.customerComputersTemplate;
}

function taskRoleStatements(template: Record<string, any>): Array<Record<string, any>> {
	for (const [key, resource] of Object.entries<any>(template.Resources ?? {})) {
		if (resource?.Type !== "AWS::IAM::Policy" || !key.includes("ComputerTaskRoleDefaultPolicy")) {
			continue;
		}
		const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
		return Array.isArray(statements) ? statements : [statements];
	}
	return [];
}

function actionsOf(statement: Record<string, any>): Set<string> {
	const raw = statement.Action ?? [];
	return new Set(typeof raw === "string" ? [raw] : (raw as unknown[]).map(String));
}

function resourcesOf(statement: Record<string, any>): unknown[] {
	const raw = statement.Resource ?? [];
	return Array.isArray(raw) ? raw : [raw];
}

function resourceMatchesSnapshotBucket(resource: unknown, bucketName: string): boolean {
	if (typeof resource === "string") {
		return resource.includes(bucketName);
	}
	const sub = (resource as { "Fn::Sub"?: unknown } | null)?.["Fn::Sub"];
	if (typeof sub === "string") {
		return sub.includes("${SnapshotBucketName}") || sub.includes(bucketName);
	}
	if (Array.isArray(sub) && sub.length > 0) {
		const template = String(sub[0]);
		if (template.includes("${SnapshotBucketName}") || template.includes(bucketName)) {
			return true;
		}
		const bindings = sub[1] as { Bucket?: unknown } | undefined;
		return JSON.stringify(bindings?.Bucket) === JSON.stringify({ Ref: "SnapshotBucketName" });
	}
	return false;
}

function snapshotReadWriteStatements(world: ChatticusWorld): Array<Record<string, any>> {
	return taskRoleStatements(computersTemplate(world)).filter((statement) => statement.Sid === "SnapshotReadWrite");
}

Given("the published customer cross-account CloudFormation template", function (this: ChatticusWorld) {
	customerRoleTemplate(this);
});

Given("the committed customer ChatticusComputers CloudFormation template", function (this: ChatticusWorld) {
	this.customerComputersTemplate = loadCustomerComputersTemplate();
});

Given("organization snapshot bucket name {string}", function (this: ChatticusWorld, bucketName: string) {
	this.expectedSnapshotBucketName = bucketName;
});

Then("the template declares an organization snapshot bucket in the customer account", function (this: ChatticusWorld) {
	const bucket = snapshotBucketResource(this);
	assert.equal(bucket.Type, "AWS::S3::Bucket");
	assert.deepEqual(bucket.Properties?.BucketName, { "Fn::Sub": "chatticus-snapshots-${OrganizationId}" });
});

Then("the bucket uses server-side encryption and blocks public access", function (this: ChatticusWorld) {
	const properties = snapshotBucketResource(this).Properties;
	assert.equal(
		properties?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm,
		"AES256",
	);
	assert.deepEqual(properties?.PublicAccessBlockConfiguration, {
		BlockPublicAcls: true,
		BlockPublicPolicy: true,
		IgnorePublicAcls: true,
		RestrictPublicBuckets: true,
	});
});

Then("the bucket has versioning enabled", function (this: ChatticusWorld) {
	assert.equal(snapshotBucketResource(this).Properties?.VersioningConfiguration?.Status, "Enabled");
});

Then("the bucket deletion policy is Retain", function (this: ChatticusWorld) {
	const bucket = snapshotBucketResource(this);
	assert.equal(bucket.DeletionPolicy, "Retain");
	assert.equal(bucket.UpdateReplacePolicy, "Retain");
});

Then("the template exports SnapshotBucketName", function (this: ChatticusWorld) {
	assert.deepEqual(customerRoleTemplate(this).Outputs?.SnapshotBucketName?.Value, { Ref: "OrganizationSnapshotBucket" });
});

Then("the cross-account role policy does not grant s3:CreateBucket", function (this: ChatticusWorld) {
	assert.ok(!grantsAction(grantedActions(crossAccountRoleStatements(this)), "s3:CreateBucket"));
});

Then("the cross-account role policy does not grant s3 on Anthus-managed snapshot buckets", function (this: ChatticusWorld) {
	const statements = crossAccountRoleStatements(this);
	assert.ok(!grantsAction(grantedActions(statements), "s3:GetObject"));
	assert.ok(!grantsAction(grantedActions(statements), "s3:PutObject"));
	assert.ok(!JSON.stringify(statements).includes("ChatticusSnapshots"));
});

Then("the cross-account role policy does not grant s3:*", function (this: ChatticusWorld) {
	const grants = grantedActions(crossAccountRoleStatements(this));
	assert.ok(!grants.includes("s3:*") && !grants.includes("*"));
	assert.ok(!grants.some((grant) => grant.startsWith("s3:")));
});

Then("the computer task role grants s3:GetObject and s3:PutObject on that bucket", function (this: ChatticusWorld) {
	const bucketName = this.expectedSnapshotBucketName;
	assert.ok(bucketName);
	const matching = snapshotReadWriteStatements(this).filter((statement) => {
		const actions = actionsOf(statement);
		return (
			actions.has("s3:GetObject") &&
			actions.has("s3:PutObject") &&
			resourcesOf(statement).some((resource) => resourceMatchesSnapshotBucket(resource, bucketName))
		);
	});
	assert.ok(matching.length > 0, `Expected Get/Put on snapshot bucket ${bucketName}`);
});

Then("the computer task role does not grant s3:CreateBucket", function (this: ChatticusWorld) {
	for (const statement of snapshotReadWriteStatements(this)) {
		assert.ok(!actionsOf(statement).has("s3:CreateBucket"));
	}
});

Then("the computer task role does not grant s3:ListBucket", function (this: ChatticusWorld) {
	for (const statement of snapshotReadWriteStatements(this)) {
		assert.ok(!actionsOf(statement).has("s3:ListBucket"));
	}
});

Then(
	"the computer container environment includes CHATTICUS_SNAPSHOT_BUCKET from the snapshot bucket parameter",
	function (this: ChatticusWorld) {
		const taskDefinitions = Object.values<any>(computersTemplate(this).Resources ?? {}).filter(
			(resource) => resource?.Type === "AWS::ECS::TaskDefinition",
		);
		assert.equal(taskDefinitions.length, 1);
		const containers = taskDefinitions[0].Properties?.ContainerDefinitions ?? [];
		assert.ok(containers.length > 0);
		const snapshotEnv = (containers[0].Environment ?? []).find(
			(entry: { Name?: string }) => entry.Name === "CHATTICUS_SNAPSHOT_BUCKET",
		);
		assert.ok(snapshotEnv);
		assert.deepEqual(snapshotEnv.Value, { Ref: "SnapshotBucketName" });
	},
);

Then("the container environment does not hardcode an Anthus snapshot bucket name", function (this: ChatticusWorld) {
	assert.ok(!JSON.stringify(computersTemplate(this)).includes("ChatticusSnapshots"));
});


function boundaryPolicyStatements(world: ChatticusWorld): Array<Record<string, any>> {
	const boundary = customerRoleTemplate(world).Resources?.ChatticusComputersBoundary;
	assert.equal(boundary?.Type, "AWS::IAM::ManagedPolicy", "The template declares no ChatticusComputersBoundary managed policy.");
	assert.equal(boundary.Properties?.ManagedPolicyName, "ChatticusComputersBoundary");
	const statements = boundary.Properties?.PolicyDocument?.Statement ?? [];
	return Array.isArray(statements) ? statements : [statements];
}

const IAM_ROLE_WRITE_ACTIONS = [
	"iam:CreateRole",
	"iam:PutRolePolicy",
	"iam:AttachRolePolicy",
	"iam:DeleteRole",
	"iam:DeleteRolePolicy",
	"iam:DetachRolePolicy",
	"iam:TagRole",
	"iam:UntagRole",
	"iam:UpdateAssumeRolePolicy",
];

function resourcesText(statement: Record<string, any>): string {
	return JSON.stringify(statement.Resource ?? []);
}

Then("the template declares a ChatticusComputersBoundary managed policy", function (this: ChatticusWorld) {
	assert.ok(boundaryPolicyStatements(this).length > 0);
});

Then("the boundary grants no IAM, STS, or organization administration actions", function (this: ChatticusWorld) {
	const grants = boundaryPolicyStatements(this).flatMap((statement) => [...actionsOf(statement)]);
	assert.ok(grants.length > 0);
	for (const grant of grants) {
		assert.doesNotMatch(grant, /^(\*|iam:|sts:|organizations:|account:|cloudformation:|ecs:|ec2:)/, `The boundary grants ${grant}.`);
	}
});

Then(
	"every IAM action that creates or changes a computer role is conditioned on the ChatticusComputersBoundary permissions boundary",
	function (this: ChatticusWorld) {
		const creating = crossAccountRoleStatements(this).filter((statement) => {
			const actions = actionsOf(statement);
			return actions.has("iam:CreateRole") || actions.has("iam:PutRolePolicy");
		});
		assert.ok(creating.length > 0);
		for (const statement of creating) {
			assert.deepEqual(
				statement.Condition?.StringEquals?.["iam:PermissionsBoundary"],
				{ Ref: "ChatticusComputersBoundary" },
				`Statement ${statement.Sid} can create or change a role without the permissions boundary.`,
			);
		}
	},
);

for (const action of ["iam:AttachRolePolicy", "iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"]) {
	Then(`the cross-account role policy does not grant ${action}`, function (this: ChatticusWorld) {
		assert.ok(!grantsAction(grantedActions(crossAccountRoleStatements(this)), action));
	});
}

Then("no IAM action that writes a role applies to ChatticusOrganizationComputerRole", function (this: ChatticusWorld) {
	for (const statement of crossAccountRoleStatements(this).filter((candidate) => candidate.Effect === "Allow")) {
		const writes = IAM_ROLE_WRITE_ACTIONS.some((action) => actionsOf(statement).has(action));
		if (writes) {
			assert.ok(
				!resourcesText(statement).includes("ChatticusOrganizationComputerRole"),
				`Statement ${statement.Sid} lets the role rewrite itself.`,
			);
		}
	}
});

Then(
	"iam:PassRole is limited to ChatticusComputers roles passed to ecs-tasks.amazonaws.com",
	function (this: ChatticusWorld) {
		const passing = crossAccountRoleStatements(this).filter((statement) => actionsOf(statement).has("iam:PassRole"));
		assert.equal(passing.length, 1);
		assert.ok(resourcesText(passing[0]).includes("role/ChatticusComputers*"));
		assert.doesNotMatch(resourcesText(passing[0]), /ChatticusOrganizationComputerRole|"\*"/);
		assert.equal(passing[0].Condition?.StringEquals?.["iam:PassedToService"], "ecs-tasks.amazonaws.com");
	},
);

Then(
	"ECS actions other than registration and listing are scoped to ChatticusComputers clusters, services, and task definitions",
	function (this: ChatticusWorld) {
		const unscopedAllowed = new Set([
			"ecs:RegisterTaskDefinition",
			"ecs:DeregisterTaskDefinition",
			"ecs:DescribeTaskDefinition",
			"ecs:ListClusters",
			"ecs:ListServices",
			"ecs:ListTasks",
		]);
		const ecsStatements = crossAccountRoleStatements(this).filter((statement) =>
			[...actionsOf(statement)].some((action) => action.startsWith("ecs:")),
		);
		for (const statement of ecsStatements) {
			if (resourcesText(statement).includes('"*"')) {
				for (const action of actionsOf(statement)) {
					assert.ok(unscopedAllowed.has(action), `${action} is granted on every ECS resource.`);
				}
			} else {
				assert.ok(resourcesText(statement).includes("ChatticusComputers*"));
			}
		}
		const grants = grantedActions(ecsStatements);
		assert.ok(grants.includes("ecs:RunTask"));
		const runTask = ecsStatements.find((statement) => actionsOf(statement).has("ecs:RunTask"))!;
		assert.ok(resourcesText(runTask).includes("task-definition/ChatticusComputers*"));
	},
);

Then(
	"every IAM role in the ChatticusComputers stack names the ChatticusComputersBoundary permissions boundary",
	function (this: ChatticusWorld) {
		const roles = Object.entries<any>(computersTemplate(this).Resources ?? {}).filter(([, resource]) => resource?.Type === "AWS::IAM::Role");
		assert.ok(roles.length >= 2);
		for (const [logicalId, role] of roles) {
			assert.deepEqual(
				role.Properties?.PermissionsBoundary,
				{ "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:policy/ChatticusComputersBoundary" },
				`${logicalId} has no permissions boundary.`,
			);
		}
	},
);
