import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import type { RecordedAwsRequest } from "../aws-request-recorder.ts";
import { frontDoorSnapshotPolicyStatements, ownerRolePolicyStatements, supervisorRolePolicyStatements, type PolicyStatement } from "../iam-policy-evaluator.ts";
import { ACCESS_ROLES, ACCESS_STORES, loadRoleAccessManifest, type AccessRole, type AccessRow, type AccessStore } from "../../src/gateway/role-access-manifest.ts";
import { FIXED_STORE_ARNS, requestsTheManifestDoesNotDescribe, rowsTheRoleCannotServe } from "../role-access-manifest.ts";
import type { ChatticusWorld } from "../world.ts";

type ManifestScenario = { rows: AccessRow[]; problems: string[] | null };

const scenarios = new WeakMap<ChatticusWorld, ManifestScenario>();

function scenarioOf(world: ChatticusWorld): ManifestScenario {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "The scenario has no manifest; a Given step should load it.");
	return scenario;
}

function roleOf(name: string): AccessRole {
	assert.ok((ACCESS_ROLES as readonly string[]).includes(name), `Unknown role ${name}`);
	return name as AccessRole;
}

function storeOf(name: string): AccessStore {
	assert.ok((ACCESS_STORES as readonly string[]).includes(name), `Unknown store ${name}`);
	return name as AccessStore;
}

const POLICY_FILES: Record<string, () => PolicyStatement[]> = {
	owner: () =>
		ownerRolePolicyStatements({
			piSessionsBucketArn: FIXED_STORE_ARNS.piSessionsBucket,
			conversationsTableArn: FIXED_STORE_ARNS.conversationsTable,
			messagingTableArn: FIXED_STORE_ARNS.messagingTable,
		}),
	supervisor: () => supervisorRolePolicyStatements({ snapshotBucketArn: FIXED_STORE_ARNS.snapshotBucket }),
	frontDoor: () => frontDoorSnapshotPolicyStatements({ snapshotBucketArn: FIXED_STORE_ARNS.snapshotBucket }),
};

const ROLE_OF_POLICY_FILE: Record<string, AccessRole> = { owner: "ownerTurn", supervisor: "supervisor", frontDoor: "frontDoor" };

function failuresOf(world: ChatticusWorld, policyFile: string): string[] {
	const statements = POLICY_FILES[policyFile]?.();
	assert.ok(statements, `Unknown policy file ${policyFile}`);
	const role = ROLE_OF_POLICY_FILE[policyFile]!;
	return rowsTheRoleCannotServe(scenarioOf(world).rows.filter((row) => row.role === role), statements, FIXED_STORE_ARNS);
}

Given("the role access manifest", function (this: ChatticusWorld) {
	scenarios.set(this, { rows: loadRoleAccessManifest(), problems: null });
});

Given("a manifest with these rows:", function (this: ChatticusWorld, table: DataTable) {
	const rows = table.hashes().map(
		(cells): AccessRow => ({
			role: roleOf(cells["role"]!),
			action: cells["action"]!,
			store: storeOf(cells["store"]!),
			keyPattern: cells["keyPattern"]!,
			exampleKey: cells["exampleKey"]!,
			...(cells["keyAlwaysExists"] === "true" ? { keyAlwaysExists: true } : {}),
		}),
	);
	scenarios.set(this, { rows, problems: null });
});

Then(/^every manifest row of the role "([^"]+)"(?: on the snapshot bucket)? is served by the (owner|supervisor|Front Door snapshot) role policy file$/, function (this: ChatticusWorld, role: string, file: string) {
	const policyFile = file === "Front Door snapshot" ? "frontDoor" : file;
	const onSnapshotBucket = policyFile === "frontDoor";
	const scenario = scenarioOf(this);
	const rows = scenario.rows.filter((row) => row.role === roleOf(role) && (!onSnapshotBucket || row.store === "snapshotBucket"));
	assert.ok(rows.length > 0, `The manifest has no row for ${role}.`);
	const failures = rowsTheRoleCannotServe(rows, POLICY_FILES[policyFile]!(), FIXED_STORE_ARNS);
	assert.deepEqual(failures, []);
});

When("the role {string} makes {string} on the {string} key {string}", function (this: ChatticusWorld, role: string, action: string, store: string, key: string) {
	const scenario = scenarioOf(this);
	const request = recordedRequestOf(action, storeOf(store), key, false);
	scenario.problems = requestsTheManifestDoesNotDescribe(scenario.rows, roleOf(role), [request], () => storeOf(store));
});

When("the role {string} reads the missing key {string} of the {string}", function (this: ChatticusWorld, role: string, key: string, store: string) {
	const scenario = scenarioOf(this);
	const request = recordedRequestOf("s3:GetObject", storeOf(store), key, true);
	scenario.problems = requestsTheManifestDoesNotDescribe(scenario.rows, roleOf(role), [request], () => storeOf(store));
});

function recordedRequestOf(action: string, store: AccessStore, key: string, objectMissing: boolean): RecordedAwsRequest {
	const isS3 = action.startsWith("s3:");
	return {
		service: isS3 ? "s3" : "dynamodb",
		action,
		store: store,
		keys: [key],
		resourceArn: FIXED_STORE_ARNS[store],
		contextKeys: {},
		...(objectMissing ? { objectMissing: true } : {}),
	};
}

Then("the access check fails with {string}", function (this: ChatticusWorld, text: string) {
	const problems = scenarioOf(this).problems;
	assert.ok(problems, "The scenario ran no access check.");
	assert.ok(problems.some((problem) => problem.includes(text)), `No problem contains ${JSON.stringify(text)}; saw:\n${problems.join("\n")}`);
});

Then("the access check passes", function (this: ChatticusWorld) {
	assert.deepEqual(scenarioOf(this).problems, []);
});

Then(/^the (owner|supervisor) role policy file serves every row$/, function (this: ChatticusWorld, file: string) {
	assert.deepEqual(failuresOf(this, file), []);
});

Then(
	/^the (owner|supervisor) role policy file refuses exactly the row "([^"]+)" because "([^"]+)"$/,
	function (this: ChatticusWorld, file: string, row: string, reason: string) {
		const failures = failuresOf(this, file);
		assert.equal(failures.length, 1, `Expected exactly one refused row; saw:\n${failures.join("\n")}`);
		assert.ok(failures[0]!.includes(row) && failures[0]!.includes(reason), failures[0]);
	},
);
