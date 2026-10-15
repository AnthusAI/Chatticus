import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { supervisorSessionTags } from "../../src/gateway/session-tags.ts";
import { tableArnOf } from "../aws-request-recorder.ts";
import { policyAllows, supervisorRolePolicyStatements, type AuthorizedRequest, type PolicyStatement, type SessionTagValues } from "../iam-policy-evaluator.ts";
import { FIXED_STORE_NAMES } from "../owner-role-support.ts";
import type { ChatticusWorld } from "../world.ts";

type SupervisorRole = { readonly statements: PolicyStatement[]; readonly tags: SessionTagValues };
type SupervisorPolicyScenario = { role: SupervisorRole | null; request: AuthorizedRequest | null };

const scenarios = new WeakMap<ChatticusWorld, SupervisorPolicyScenario>();

function scenarioOf(world: ChatticusWorld): SupervisorPolicyScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { role: null, request: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function roleOf(world: ChatticusWorld): SupervisorRole {
	const role = scenarioOf(world).role;
	assert.ok(role, "The scenario has no supervisor role.");
	return role;
}

function requestOf(world: ChatticusWorld): AuthorizedRequest {
	const request = scenarioOf(world).request;
	assert.ok(request, "The scenario made no request.");
	return request;
}

const STORE_NAMES: Record<string, string> = {
	messaging: FIXED_STORE_NAMES.messagingTable,
	conversations: FIXED_STORE_NAMES.conversationsTable,
};

Given("the supervisor role of organization {string} on computer {string}", function (this: ChatticusWorld, tenantId: string, computerId: string) {
	scenarioOf(this).role = {
		statements: supervisorRolePolicyStatements({ snapshotBucketArn: `arn:aws:s3:::${FIXED_STORE_NAMES.snapshotBucket}` }),
		tags: Object.fromEntries(supervisorSessionTags({ tenantId, computerId }).map((tag) => [tag.Key, tag.Value])),
	};
});

When("the supervisor requests {string} on the object {string} of bucket {string}", function (this: ChatticusWorld, action: string, key: string, bucket: string) {
	scenarioOf(this).request = { action, resourceArn: `arn:aws:s3:::${bucket}/${key}`, contextKeys: {} };
});

When("the supervisor lists bucket {string} with the prefix {string}", function (this: ChatticusWorld, bucket: string, prefix: string) {
	scenarioOf(this).request = { action: "s3:ListBucket", resourceArn: `arn:aws:s3:::${bucket}`, contextKeys: { "s3:prefix": [prefix] } };
});

When("the supervisor requests {string} on the {string} table for the keys {string}", function (this: ChatticusWorld, action: string, table: string, keys: string) {
	const tableName = STORE_NAMES[table];
	assert.ok(tableName, `Unknown table ${table}`);
	scenarioOf(this).request = { action, resourceArn: tableArnOf(tableName), contextKeys: { "dynamodb:LeadingKeys": keys.split(",") } };
});

When("the supervisor requests {string} on the {string} table with no key", function (this: ChatticusWorld, action: string, table: string) {
	const tableName = STORE_NAMES[table];
	assert.ok(tableName, `Unknown table ${table}`);
	scenarioOf(this).request = { action, resourceArn: tableArnOf(tableName), contextKeys: {} };
});

When("the supervisor requests {string} on the resource {string}", function (this: ChatticusWorld, action: string, resourceArn: string) {
	scenarioOf(this).request = { action, resourceArn, contextKeys: {} };
});

Then("the supervisor role allows the request", function (this: ChatticusWorld) {
	const request = requestOf(this);
	assert.equal(policyAllows(roleOf(this).statements, roleOf(this).tags, request), true, `Denied: ${JSON.stringify(request)}`);
});

Then("the supervisor role denies the request", function (this: ChatticusWorld) {
	const request = requestOf(this);
	assert.equal(policyAllows(roleOf(this).statements, roleOf(this).tags, request), false, `Allowed: ${JSON.stringify(request)}`);
});

const COMPUTER_PREFIX = `arn:aws:s3:::${FIXED_STORE_NAMES.snapshotBucket}/tenants/\${aws:PrincipalTag/tenant}/computers/\${aws:PrincipalTag/computer}/`;

function statementsWithEffect(world: ChatticusWorld, effect: "Allow" | "Deny"): PolicyStatement[] {
	return roleOf(world).statements.filter((statement) => statement.Effect === effect);
}

Then("the supervisor role has exactly two statements", function (this: ChatticusWorld) {
	assert.equal(roleOf(this).statements.length, 2);
	assert.equal(statementsWithEffect(this, "Allow").length, 1);
	assert.equal(statementsWithEffect(this, "Deny").length, 1);
});

Then("the supervisor role allow statement allows only get, put and abort of multipart upload", function (this: ChatticusWorld) {
	assert.deepEqual([...statementsWithEffect(this, "Allow")[0]!.Action].sort(), ["s3:AbortMultipartUpload", "s3:GetObject", "s3:PutObject"]);
});

Then(
	"the supervisor role deny statement denies put, delete, delete of a version, tagging and abort of multipart upload on the overlay prefix built from both session tags",
	function (this: ChatticusWorld) {
		const [deny] = statementsWithEffect(this, "Deny");
		assert.deepEqual([...deny!.Action].sort(), [
			"s3:AbortMultipartUpload",
			"s3:DeleteObject",
			"s3:DeleteObjectVersion",
			"s3:PutObject",
			"s3:PutObjectTagging",
		]);
		assert.deepEqual(deny!.Resource, [`${COMPUTER_PREFIX}overlay/*`]);
	},
);

Then("every resource of the supervisor role statements is a snapshot object path built from both session tags", function (this: ChatticusWorld) {
	for (const statement of roleOf(this).statements) {
		for (const resource of statement.Resource) {
			assert.ok(resource.startsWith(COMPUTER_PREFIX), `${statement.Sid ?? "statement"} names ${resource}`);
			assert.ok(resource === `${COMPUTER_PREFIX}*` || resource === `${COMPUTER_PREFIX}overlay/*`, `${statement.Sid ?? "statement"} names ${resource}`);
		}
	}
});

Then("the supervisor role statements hold no condition and no wildcard action", function (this: ChatticusWorld) {
	for (const statement of roleOf(this).statements) {
		assert.equal(statement.Condition, undefined, `${statement.Sid ?? "statement"} carries a condition`);
		for (const action of statement.Action) assert.ok(!action.includes("*"), `${statement.Sid ?? "statement"} names ${action}`);
	}
});
