import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { tableArnOf } from "../aws-request-recorder.ts";
import { policyAllows, type AuthorizedRequest } from "../iam-policy-evaluator.ts";
import { FIXED_STORE_NAMES, ownerRoleFor, type OwnerRole } from "../owner-role-support.ts";
import type { ChatticusWorld } from "../world.ts";

type RolePolicyScenario = { role: OwnerRole | null; request: AuthorizedRequest | null };

const scenarios = new WeakMap<ChatticusWorld, RolePolicyScenario>();

function scenarioOf(world: ChatticusWorld): RolePolicyScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { role: null, request: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function roleOf(world: ChatticusWorld): OwnerRole {
	const role = scenarioOf(world).role;
	assert.ok(role, "The scenario has no owner role.");
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

Given(
	"the owner role of bot {string} in channel {string} of organization {string} on computer {string} in turn {string}",
	function (this: ChatticusWorld, botId: string, channelId: string, tenantId: string, computerId: string, turnId: string) {
		scenarioOf(this).role = ownerRoleFor({ tenantId, botId, channelId, computerId, turnId });
	},
);

When("the owner requests {string} on the {string} table for the keys {string}", function (this: ChatticusWorld, action: string, table: string, keys: string) {
	const tableName = STORE_NAMES[table];
	assert.ok(tableName, `Unknown table ${table}`);
	scenarioOf(this).request = {
		action,
		resourceArn: tableArnOf(tableName),
		contextKeys: { "dynamodb:LeadingKeys": keys.split(",") },
	};
});

When("the owner requests {string} on the {string} table with no key", function (this: ChatticusWorld, action: string, table: string) {
	const tableName = STORE_NAMES[table];
	assert.ok(tableName, `Unknown table ${table}`);
	scenarioOf(this).request = { action, resourceArn: tableArnOf(tableName), contextKeys: {} };
});

When("the owner requests {string} on the object {string} of bucket {string}", function (this: ChatticusWorld, action: string, key: string, bucket: string) {
	scenarioOf(this).request = { action, resourceArn: `arn:aws:s3:::${bucket}/${key}`, contextKeys: {} };
});

When("the owner lists bucket {string} with the prefix {string}", function (this: ChatticusWorld, bucket: string, prefix: string) {
	scenarioOf(this).request = { action: "s3:ListBucket", resourceArn: `arn:aws:s3:::${bucket}`, contextKeys: { "s3:prefix": [prefix] } };
});

Then("the owner role allows the request", function (this: ChatticusWorld) {
	const request = requestOf(this);
	assert.equal(policyAllows(roleOf(this).statements, roleOf(this).tags, request), true, `Denied: ${JSON.stringify(request)}`);
});

Then("the owner role denies the request", function (this: ChatticusWorld) {
	const request = requestOf(this);
	assert.equal(policyAllows(roleOf(this).statements, roleOf(this).tags, request), false, `Allowed: ${JSON.stringify(request)}`);
});

Then("the owner role statements hold no action that carries no key", function (this: ChatticusWorld) {
	const keyless = /^dynamodb:(Scan|BatchWriteItem|TransactWriteItems|TransactGetItems|PartiQL.*|Describe.*|List.*)$|^dynamodb:\*$|^s3:\*$|^\*$/;
	for (const statement of roleOf(this).statements) {
		for (const action of statement.Action) assert.ok(!keyless.test(action), `${statement.Sid ?? "statement"} names ${action}`);
	}
});

Then("the owner role statements hold no key pattern that ends in a bare tenant wildcard", function (this: ChatticusWorld) {
	for (const statement of roleOf(this).statements) {
		for (const values of Object.values(statement.Condition ?? {})) {
			for (const pattern of values["dynamodb:LeadingKeys"] ?? []) {
				assert.notEqual(pattern, "${aws:PrincipalTag/tenant}#*", `${statement.Sid ?? "statement"} grants the whole tenant`);
			}
		}
	}
});

Then("the owner role statements give the roster nothing but GetItem", function (this: ChatticusWorld) {
	for (const statement of roleOf(this).statements) {
		for (const values of Object.values(statement.Condition ?? {})) {
			if (!(values["dynamodb:LeadingKeys"] ?? []).some((pattern) => pattern.endsWith("#roster"))) continue;
			assert.deepEqual(statement.Action, ["dynamodb:GetItem"], `${statement.Sid ?? "statement"} grants more on the roster`);
		}
	}
});

Then("every resource of the owner role statements is a store of the role or an object path built from session tags", function (this: ChatticusWorld) {
	const stores = [
		`arn:aws:s3:::${FIXED_STORE_NAMES.piSessionsBucket}`,
		`arn:aws:s3:::${FIXED_STORE_NAMES.snapshotBucket}`,
		tableArnOf(FIXED_STORE_NAMES.conversationsTable),
		tableArnOf(FIXED_STORE_NAMES.messagingTable),
	];
	for (const statement of roleOf(this).statements) {
		for (const resource of statement.Resource) {
			const isStore = stores.includes(resource) || resource === `${tableArnOf(FIXED_STORE_NAMES.conversationsTable)}/index/*`;
			const isSessionPath = resource.includes("${aws:PrincipalTag/tenant}") && stores.some((store) => resource.startsWith(`${store}/`));
			assert.ok(isStore || isSessionPath, `${statement.Sid ?? "statement"} names ${resource}`);
		}
	}
});
