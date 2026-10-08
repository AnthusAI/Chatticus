import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { buildSessionPolicy, type SessionPolicyDocument, type SessionScope } from "../../src/gateway/session-policy.ts";
import type { ChatticusWorld } from "../world.ts";

type PolicyScenario = { sessions: SessionScope[]; policies: SessionPolicyDocument[]; refusal: Error | null };

const scenarios = new WeakMap<ChatticusWorld, PolicyScenario>();

function scenarioOf(world: ChatticusWorld): PolicyScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { sessions: [], policies: [], refusal: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const BUCKET = "pi-sessions";
const TABLE_NAME = "conversations";
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:111122223333:table/${TABLE_NAME}`;

function onlyPolicy(world: ChatticusWorld): SessionPolicyDocument {
	const [policy] = scenarioOf(world).policies;
	assert.ok(policy, "No policy was built");
	return policy;
}

const statementsOf = (policy: SessionPolicyDocument, service: "s3" | "dynamodb") =>
	policy.Statement.filter((statement) => statement.Action.every((action) => action.startsWith(`${service}:`)));

Given(
	"the session of bot {string} in channel {string} of organization {string}",
	function (this: ChatticusWorld, botId: string, channelId: string, tenantId: string) {
		scenarioOf(this).sessions.push({ tenantId, botId, channelId, bucketName: BUCKET, conversationsTableArn: TABLE_ARN });
	},
);

When("the storage policy is built for the session", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	try {
		scenario.policies = [buildSessionPolicy(scenario.sessions[0]!)];
	} catch (error) {
		scenario.refusal = error as Error;
	}
});

When("the storage policy is built for each session", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.policies = scenario.sessions.map((session) => buildSessionPolicy(session));
});

Then(
	"the policy allows objects only under the prefix {string} of bucket {string}",
	function (this: ChatticusWorld, prefix: string, bucket: string) {
		const statements = statementsOf(onlyPolicy(this), "s3");
		assert.ok(statements.length > 0);
		for (const statement of statements) {
			for (const resource of statement.Resource) {
				assert.ok(resource === `arn:aws:s3:::${bucket}` || resource.startsWith(`arn:aws:s3:::${bucket}/${prefix}`), resource);
			}
			for (const condition of Object.values(statement.Condition ?? {})) {
				for (const values of Object.values(condition)) {
					for (const value of values) assert.ok(value.startsWith(prefix), value);
				}
			}
		}
		const objectResources = statements.flatMap((statement) => statement.Resource).filter((resource) => resource.includes("/"));
		assert.deepEqual(objectResources, [`arn:aws:s3:::${bucket}/${prefix}*`]);
	},
);

Then("the policy allows table items only with the partition key {string}", function (this: ChatticusWorld, partitionKey: string) {
	const statements = statementsOf(onlyPolicy(this), "dynamodb");
	assert.ok(statements.length > 0);
	for (const statement of statements) {
		assert.deepEqual(statement.Condition, { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [partitionKey] } });
	}
});

Then(
	"every resource of the policy belongs to bucket {string} or to the table {string}",
	function (this: ChatticusWorld, bucket: string, table: string) {
		for (const statement of onlyPolicy(this).Statement) {
			for (const resource of statement.Resource) {
				const ok = resource.startsWith(`arn:aws:s3:::${bucket}`) || resource.includes(`:table/${table}`);
				assert.ok(ok, resource);
				assert.ok(resource === `arn:aws:s3:::${bucket}` || !resource.endsWith(`${bucket}/*`), resource);
			}
		}
	},
);

Then("the policy grants no wildcard action", function (this: ChatticusWorld) {
	for (const statement of onlyPolicy(this).Statement) {
		for (const action of statement.Action) assert.ok(!action.includes("*"), action);
	}
});

Then("the two policies share no object prefix and no partition key", function (this: ChatticusWorld) {
	const [first, second] = scenarioOf(this).policies;
	assert.ok(first && second);
	const keysOf = (policy: SessionPolicyDocument) =>
		policy.Statement.flatMap((statement) => Object.values(statement.Condition ?? {}).flatMap((condition) => Object.values(condition).flat()));
	const objectPrefix = (policy: SessionPolicyDocument) =>
		statementsOf(policy, "s3")
			.flatMap((statement) => statement.Resource)
			.filter((resource) => resource.includes("/conversations/"));
	for (const resource of objectPrefix(first)) assert.ok(!objectPrefix(second).includes(resource));
	const leading = (policy: SessionPolicyDocument) => keysOf(policy).filter((key) => key.startsWith("PI#"));
	for (const key of leading(first)) assert.ok(!leading(second).includes(key));
	assert.ok(leading(first).length > 0 && objectPrefix(first).length > 0);
});

Then("building the policy is refused", function (this: ChatticusWorld) {
	assert.ok(scenarioOf(this).refusal, "A policy was built for an unsafe identifier");
});
