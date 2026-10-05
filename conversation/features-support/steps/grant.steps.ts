import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { TaskCapabilityGrant } from "../../src/policy/capability-policy.ts";
import { AutoReviewRuleKind } from "../../src/policy/models.ts";
import {
	USER_CONTROLLED_COMPLETION_REQUIRED,
	WAITING_FOR_HUMAN,
	type OvernightGatedResult,
} from "../../src/policy/overnight.ts";
import { POLICY_KERNEL_TENANT, POLICY_KERNEL_TURN } from "../../src/policy/sinks.ts";
import { kernelPolicyFor, policyControlFor, tableAsMap } from "../policy-control.ts";
import type { ChatticusWorld } from "../world.ts";

const OVERNIGHT_TENANT = "anthus";

function lastOvernightOf(world: ChatticusWorld): OvernightGatedResult {
	assert.ok(world.lastOvernight !== null, "no gated action was attempted");
	return world.lastOvernight;
}

Given("an overnight task grants structured consequential actions", function (this: ChatticusWorld) {
	const grant = new TaskCapabilityGrant(
		new Set(["send", "purchase"]),
		new Set(),
		new Set(["alex@example.com", "other@example.com", "store.example"]),
		new Set(),
		new Set(["structured_send", "file_transfer"]),
		new Set(),
	);
	policyControlFor(this).setTurnCapabilityGrant(OVERNIGHT_TENANT, POLICY_KERNEL_TURN, grant);
	this.policyTenantId = OVERNIGHT_TENANT;
});

Given("an exact-approval task grants structured send", function (this: ChatticusWorld) {
	const grant = new TaskCapabilityGrant(
		new Set(["send"]),
		new Set(),
		new Set(["alex@example.com", "other@example.com"]),
		new Set(),
		new Set(["structured_send"]),
		new Set(),
	);
	policyControlFor(this).setTurnCapabilityGrant(POLICY_KERNEL_TENANT, POLICY_KERNEL_TURN, grant);
});

Given("the laptop is closed and no human is at a screen", function (this: ChatticusWorld) {
	this.watcherPresent = false;
});

Given(
	"a human created an always-allow rule for structured {string} with:",
	async function (this: ChatticusWorld, actionType: string, table: DataTable) {
		const recorded = await policyControlFor(this).addAutoReviewRule(
			AutoReviewRuleKind.AlwaysAllow,
			actionType,
			OVERNIGHT_TENANT,
			null,
			{ arguments: tableAsMap(table), createdBy: "human" },
		);
		assert.equal(recorded, true, "the human rule was not recorded");
	},
);

async function reachUnattendedAction(
	world: ChatticusWorld,
	actionType: string,
	table: DataTable,
	channel: string,
): Promise<void> {
	assert.notEqual(world.watcherPresent, true, "a human is watching; this is not an unattended turn");
	world.lastOvernight = await policyControlFor(world).resolveUnattendedGatedAction(actionType, OVERNIGHT_TENANT, {
		arguments: tableAsMap(table),
		channel,
	});
}

When(
	"the unattended turn reaches structured action {string} with:",
	async function (this: ChatticusWorld, actionType: string, table: DataTable) {
		await reachUnattendedAction(this, actionType, table, "structured");
	},
);

When(
	"the unattended turn reaches browser action {string} with:",
	async function (this: ChatticusWorld, actionType: string, table: DataTable) {
		await reachUnattendedAction(this, actionType, table, "browser");
	},
);

When("a bot tries to add an always-allow rule for {string}", async function (this: ChatticusWorld, actionType: string) {
	await policyControlFor(this).addAutoReviewRule(AutoReviewRuleKind.AlwaysAllow, actionType, OVERNIGHT_TENANT, null, {
		arguments: { recipient: "alex@example.com", body: "hello" },
		createdBy: "bot",
	});
});

Then(
	"a later unattended {string} with those arguments is still not executed",
	async function (this: ChatticusWorld, actionType: string) {
		const later = await policyControlFor(this).resolveUnattendedGatedAction(actionType, OVERNIGHT_TENANT, {
			arguments: { recipient: "alex@example.com", body: "hello" },
			channel: "structured",
		});
		assert.equal(later.executed, false);
	},
);

Then("the action is not executed", function (this: ChatticusWorld) {
	assert.equal(lastOvernightOf(this).executed, false);
});

Then("the action executes", function (this: ChatticusWorld) {
	const result = lastOvernightOf(this);
	assert.equal(result.executed, true);
	assert.equal(result.turn_status, "completed");
});

Then("the turn is blocked waiting for a human", function (this: ChatticusWorld) {
	const result = lastOvernightOf(this);
	assert.equal(result.turn_status, "blocked");
	assert.equal(result.reason, WAITING_FOR_HUMAN);
});

Then("the kernel refuses the bot-initiated auto-review loosening", async function (this: ChatticusWorld) {
	const refused = await policyControlFor(this).refusedBotAutoReview(OVERNIGHT_TENANT);
	assert.ok(
		refused.some(([tenantId, actionType]) => tenantId === OVERNIGHT_TENANT && actionType === "send"),
		"the bot-initiated always-allow was not refused",
	);
});

Then("completion evidence is recorded", function (this: ChatticusWorld) {
	assert.ok(lastOvernightOf(this).completion_evidence);
});

Then("the turn reports that user-controlled completion is required", function (this: ChatticusWorld) {
	assert.equal(lastOvernightOf(this).reason, USER_CONTROLLED_COMPLETION_REQUIRED);
});

Then("the routine does not retry the action unattended", function (this: ChatticusWorld) {
	assert.equal(lastOvernightOf(this).retried_unattended, false);
});

When("the model attempts to {} through an authenticated browser", function (this: ChatticusWorld, action: string) {
	kernelPolicyFor(this);
	this.lastOvernight = policyControlFor(this).attemptAuthenticatedBrowserAction(action.trim());
});

Given(
	"a structured connector can bind action {string} with:",
	function (this: ChatticusWorld, actionType: string, table: DataTable) {
		const args = tableAsMap(table);
		kernelPolicyFor(this).bindConnector(actionType, args["destination"], args["payload"]);
	},
);

When("the user approves that bound operation", function (this: ChatticusWorld) {
	kernelPolicyFor(this).approveBoundOperation();
});

When("the worker executes the bound connector operation", function (this: ChatticusWorld) {
	const result = kernelPolicyFor(this).executeBoundConnector("smtp-250");
	this.lastOvernight = result;
	this.recordedCompletionEvidence = result.completion_evidence;
});

Given("the human takes over the computer for an identity check", function (this: ChatticusWorld) {
	kernelPolicyFor(this).requireTakeover("identity check");
});

When("the model reaches an authenticated browser {string}", function (this: ChatticusWorld, action: string) {
	const policy = kernelPolicyFor(this);
	policy.requireTakeover(action);
	this.lastOvernight = policy.last_overnight;
});

Then("the worker does not complete the purchase itself", function (this: ChatticusWorld) {
	assert.equal(kernelPolicyFor(this).worker_completed_takeover_action, false);
});

Then("the turn waits for the human to finish the blocked step", function (this: ChatticusWorld) {
	assert.equal(kernelPolicyFor(this).takeover_waiting, true);
});

When("the model needs a password, passkey, or one-time code", function (this: ChatticusWorld) {
	kernelPolicyFor(this).requireTakeover("password");
});

Then("the worker does not accept the secret from the channel", function (this: ChatticusWorld) {
	assert.equal(kernelPolicyFor(this).channel_secret_accepted, false);
});
