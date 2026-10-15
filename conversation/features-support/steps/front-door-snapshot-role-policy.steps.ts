import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { frontDoorSnapshotPolicyStatements, objectReadOutcome, policyAllows, type PolicyStatement } from "../iam-policy-evaluator.ts";
import { FIXED_STORE_NAMES } from "../owner-role-support.ts";
import type { ChatticusWorld } from "../world.ts";

type FrontDoorScenario = { statements: PolicyStatement[]; outcome: string | null; allowed: boolean | null };

const scenarios = new WeakMap<ChatticusWorld, FrontDoorScenario>();
const BUCKET_ARN = `arn:aws:s3:::${FIXED_STORE_NAMES.snapshotBucket}`;

function scenarioOf(world: ChatticusWorld): FrontDoorScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { statements: [], outcome: null, allowed: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

Given("the Front Door role of the snapshot bucket", function (this: ChatticusWorld) {
	scenarioOf(this).statements = frontDoorSnapshotPolicyStatements({ snapshotBucketArn: BUCKET_ARN });
});

When("the Front Door reads the key {string} which {string}", function (this: ChatticusWorld, key: string, existence: string) {
	const scenario = scenarioOf(this);
	assert.ok(existence === "exists" || existence === "is missing", `Unknown existence ${existence}`);
	scenario.outcome = objectReadOutcome(scenario.statements, {}, BUCKET_ARN, key, existence === "exists");
});

When("the Front Door requests {string} on the key {string}", function (this: ChatticusWorld, action: string, key: string) {
	const scenario = scenarioOf(this);
	scenario.allowed = policyAllows(scenario.statements, {}, { action, resourceArn: `${BUCKET_ARN}/${key}`, contextKeys: {} });
});

Then("S3 answers {string}", function (this: ChatticusWorld, answer: string) {
	assert.equal(scenarioOf(this).outcome, answer);
});

Then("the Front Door role allows the request", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).allowed, true);
});

Then("the Front Door role denies the request", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).allowed, false);
});

Then("the Front Door role has exactly the statements {string}", function (this: ChatticusWorld, sids: string) {
	assert.deepEqual(scenarioOf(this).statements.map((statement) => statement.Sid), sids.split(", "));
});

Then("the Front Door role lists the bucket with no condition", function (this: ChatticusWorld) {
	const listing = scenarioOf(this).statements.find((statement) => statement.Action.includes("s3:ListBucket"));
	assert.ok(listing);
	assert.equal(listing.Condition, undefined);
	assert.deepEqual(listing.Resource, [BUCKET_ARN]);
});
