import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Given, Then } from "@cucumber/cucumber";
import { loadCustomerComputersTemplate } from "../../src/computer/customer-template.ts";
import type { ChatticusWorld } from "../world.ts";

const CUSTOMER_ROLE_TEMPLATE_URL = new URL("../../../infra/customer-role.yml", import.meta.url);

function customerRoleTemplate(world: ChatticusWorld): string {
	if (world.customerRoleTemplate === null) {
		world.customerRoleTemplate = readFileSync(CUSTOMER_ROLE_TEMPLATE_URL, "utf8");
	}
	return world.customerRoleTemplate;
}

function crossAccountRoleSection(world: ChatticusWorld): string {
	const section = customerRoleTemplate(world).split("ChatticusCrossAccountRole:")[1];
	assert.ok(section !== undefined, "The template declares no ChatticusCrossAccountRole.");
	return section;
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
	const template = customerRoleTemplate(this);
	assert.ok(template.includes("OrganizationSnapshotBucket:"));
	assert.ok(template.includes("Type: 'AWS::S3::Bucket'") || template.includes("Type: AWS::S3::Bucket"));
	assert.ok(template.includes("BucketName: !Sub 'chatticus-snapshots-${OrganizationId}'"));
});

Then("the bucket uses server-side encryption and blocks public access", function (this: ChatticusWorld) {
	const template = customerRoleTemplate(this);
	for (const fragment of [
		"BucketEncryption:",
		"SSEAlgorithm: AES256",
		"PublicAccessBlockConfiguration:",
		"BlockPublicAcls: true",
		"RestrictPublicBuckets: true",
	]) {
		assert.ok(template.includes(fragment), fragment);
	}
});

Then("the bucket has versioning enabled", function (this: ChatticusWorld) {
	const template = customerRoleTemplate(this);
	assert.ok(template.includes("VersioningConfiguration:"));
	assert.ok(template.includes("Status: Enabled"));
});

Then("the bucket deletion policy is Retain", function (this: ChatticusWorld) {
	const bucketSection = (customerRoleTemplate(this).split("OrganizationSnapshotBucket:")[1] ?? "").split("Outputs:")[0] ?? "";
	assert.ok(bucketSection.includes("DeletionPolicy: Retain"));
	assert.ok(bucketSection.includes("UpdateReplacePolicy: Retain"));
});

Then("the template exports SnapshotBucketName", function (this: ChatticusWorld) {
	const template = customerRoleTemplate(this);
	assert.ok(template.includes("SnapshotBucketName:"));
	assert.ok(template.includes("!Ref OrganizationSnapshotBucket"));
});

Then("the cross-account role policy does not grant s3:CreateBucket", function (this: ChatticusWorld) {
	assert.ok(!crossAccountRoleSection(this).includes("s3:CreateBucket"));
});

Then("the cross-account role policy does not grant s3 on Anthus-managed snapshot buckets", function (this: ChatticusWorld) {
	const section = crossAccountRoleSection(this);
	assert.ok(!section.includes("ChatticusSnapshots"));
	assert.ok(!/s3:[A-Za-z*]+/.test(section));
});

Then("the cross-account role policy does not grant s3:*", function (this: ChatticusWorld) {
	assert.ok(!crossAccountRoleSection(this).includes("s3:*"));
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
