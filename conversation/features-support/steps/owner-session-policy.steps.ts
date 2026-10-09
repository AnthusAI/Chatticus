import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	buildOwnerSessionPolicy,
	buildSessionPolicy,
	SESSION_POLICY_MAXIMUM_CHARACTERS,
	type OwnerSessionScope,
	type SessionPolicyDocument,
} from "../../src/gateway/session-policy.ts";
import type { ChatticusWorld } from "../world.ts";

type OwnerPolicyScenario = { sessions: OwnerSessionScope[]; policies: SessionPolicyDocument[]; refusal: Error | null };

const scenarios = new WeakMap<ChatticusWorld, OwnerPolicyScenario>();

function scenarioOf(world: ChatticusWorld): OwnerPolicyScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { sessions: [], policies: [], refusal: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const PI_BUCKET = "pi-sessions";
const PI_TABLE_ARN = "arn:aws:dynamodb:us-east-1:111122223333:table/conversations";
const SNAPSHOT_BUCKET = "snapshots";
const MESSAGING_TABLE_ARN = "arn:aws:dynamodb:us-east-1:111122223333:table/messaging";

Given(
	"the owner session of bot {string} in channel {string} of organization {string} on computer {string}",
	function (this: ChatticusWorld, botId: string, channelId: string, tenantId: string, computerId: string) {
		scenarioOf(this).sessions.push({
			tenantId,
			botId,
			channelId,
			bucketName: PI_BUCKET,
			conversationsTableArn: PI_TABLE_ARN,
			computerId,
			snapshotBucketName: SNAPSHOT_BUCKET,
			messagingTableArn: MESSAGING_TABLE_ARN,
		});
	},
);

Given("the owner session with identifiers as long as the platform generates them", function (this: ChatticusWorld) {
	const uuid = "0f8c2a1e-9b7d-4c3a-8e5f-1a2b3c4d5e6f";
	scenarioOf(this).sessions.push({
		tenantId: "household-tenant-with-a-long-name-0123",
		botId: `bot-${uuid}`,
		channelId: `channel-${uuid}`,
		bucketName: "chatticus-development-pisessions-123456789012-us-east-1",
		conversationsTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/ChatticusThinTurn-ConversationsTable-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		computerId: `computer-${uuid}`,
		snapshotBucketName: "chatticus-snapshots-123456789012-us-east-1",
		messagingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/ChatticusThinTurn-MessagingTable-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	});
});

When("the owner policy is built for the session", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	try {
		scenario.policies = [buildOwnerSessionPolicy(scenario.sessions[0]!)];
	} catch (error) {
		scenario.refusal = error as Error;
	}
});

When("the owner policy is built for each session", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.policies = scenario.sessions.map((session) => buildOwnerSessionPolicy(session));
});

function onlyPolicy(world: ChatticusWorld): SessionPolicyDocument {
	const [policy] = scenarioOf(world).policies;
	assert.ok(policy, "No owner policy was built");
	return policy;
}

Then("the owner policy still allows the conversation session of the plain policy", function (this: ChatticusWorld) {
	const plain = buildSessionPolicy(scenarioOf(this).sessions[0]!);
	assert.deepEqual(onlyPolicy(this).Statement.slice(0, plain.Statement.length), plain.Statement);
});

Then(
	"the owner policy allows snapshot objects only under {string} of bucket {string}",
	function (this: ChatticusWorld, prefix: string, bucket: string) {
		const statements = onlyPolicy(this).Statement.filter((statement) => statement.Resource.some((resource) => resource.startsWith(`arn:aws:s3:::${bucket}`)));
		assert.equal(statements.length, 1, "Exactly one statement names the snapshot bucket");
		assert.deepEqual(statements[0]!.Resource, [`arn:aws:s3:::${bucket}/${prefix}*`]);
		assert.deepEqual(statements[0]!.Action, ["s3:GetObject", "s3:PutObject"]);
	},
);

Then(
	"the owner policy allows messaging items only with partition keys starting {string} or equal to {string} in the table {string}",
	function (this: ChatticusWorld, prefix: string, mailbox: string, table: string) {
		const statements = onlyPolicy(this).Statement.filter((statement) => statement.Resource.some((resource) => resource.endsWith(`:table/${table}`)));
		assert.equal(statements.length, 1, "Exactly one statement names the messaging table");
		assert.deepEqual(statements[0]!.Resource, [`arn:aws:dynamodb:us-east-1:111122223333:table/${table}`]);
		assert.deepEqual(statements[0]!.Condition, { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${prefix}*`, mailbox] } });
		for (const action of statements[0]!.Action) assert.ok(!action.includes("*") && action !== "dynamodb:Scan", action);
	},
);

Then("the two owner policies share no snapshot prefix and no messaging partition prefix", function (this: ChatticusWorld) {
	const [first, second] = scenarioOf(this).policies;
	assert.ok(first && second);
	const snapshotResources = (policy: SessionPolicyDocument) =>
		policy.Statement.flatMap((statement) => statement.Resource).filter((resource) => resource.startsWith(`arn:aws:s3:::${SNAPSHOT_BUCKET}/`));
	const messagingPrefixes = (policy: SessionPolicyDocument) =>
		policy.Statement.flatMap((statement) => statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] ?? []);
	assert.ok(snapshotResources(first).length > 0 && messagingPrefixes(first).length > 0);
	for (const resource of snapshotResources(first)) assert.ok(!snapshotResources(second).includes(resource));
	for (const prefix of messagingPrefixes(first)) assert.ok(!messagingPrefixes(second).includes(prefix));
});

Then("the owner policy is within the STS size limit", function (this: ChatticusWorld) {
	const length = JSON.stringify(onlyPolicy(this)).length;
	assert.ok(length <= SESSION_POLICY_MAXIMUM_CHARACTERS, `${length} characters`);
});

Then("building the owner policy is refused", function (this: ChatticusWorld) {
	assert.ok(scenarioOf(this).refusal, "An owner policy was built for an unsafe identifier");
});

Then(
	"every table statement of the owner policy allows the actions {string}",
	function (this: ChatticusWorld, actions: string) {
		const tableStatements = onlyPolicy(this).Statement.filter((statement) => statement.Resource.some((resource) => resource.includes(":table/")));
		assert.equal(tableStatements.length, 2, "The conversation table and the messaging table each have one statement");
		for (const statement of tableStatements) {
			for (const action of actions.split(",")) assert.ok(statement.Action.includes(action), `${action} missing from ${statement.Resource.join(",")}`);
		}
	},
);

Then("the conversation table statement of the owner policy also allows the action {string}", function (this: ChatticusWorld, action: string) {
	const statement = onlyPolicy(this).Statement.find((candidate) => candidate.Resource.includes(PI_TABLE_ARN));
	assert.ok(statement, "The conversation table has a statement");
	assert.ok(statement.Action.includes(action), `${action} missing`);
});
