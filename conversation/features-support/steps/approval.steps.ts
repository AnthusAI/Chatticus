import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { DESTINATION_CHANGED, PAYLOAD_CHANGED } from "../../src/policy/approval-binding.ts";
import { AutoReviewRuleKind } from "../../src/policy/models.ts";
import { POLICY_KERNEL_TENANT, POLICY_KERNEL_TURN } from "../../src/policy/sinks.ts";
import { policyControlFor, tableAsMap } from "../policy-control.ts";
import type { ChatticusWorld } from "../world.ts";

const DEFAULT_TENANT = "anthus";

When("a bot proposes action type {string}", async function (this: ChatticusWorld, actionType: string) {
	this.lastDecision = await policyControlFor(this).evaluateAction(actionType, DEFAULT_TENANT);
});

When(
	"tenant {string} proposes action type {string}",
	async function (this: ChatticusWorld, tenantId: string, actionType: string) {
		this.lastDecision = await policyControlFor(this).evaluateAction(actionType, tenantId);
	},
);

Then("the decision is {string}", function (this: ChatticusWorld, decision: string) {
	assert.ok(this.lastDecision !== null, "no decision was evaluated");
	assert.equal(this.lastDecision.toLowerCase(), decision);
});

Given("an auto-review rule always-allow for {string}", async function (this: ChatticusWorld, actionType: string) {
	await policyControlFor(this).addAutoReviewRule(AutoReviewRuleKind.AlwaysAllow, actionType, DEFAULT_TENANT);
});

Given("an auto-review rule require-approval for {string}", async function (this: ChatticusWorld, actionType: string) {
	await policyControlFor(this).addAutoReviewRule(AutoReviewRuleKind.RequireApproval, actionType, DEFAULT_TENANT);
});

Given("an auto-review rule never-allow for {string}", async function (this: ChatticusWorld, actionType: string) {
	await policyControlFor(this).addAutoReviewRule(AutoReviewRuleKind.NeverAllow, actionType, DEFAULT_TENANT);
});

Given(
	"tenant {string} has an auto-review rule never-allow for {string}",
	async function (this: ChatticusWorld, tenantId: string, actionType: string) {
		await policyControlFor(this).addAutoReviewRule(AutoReviewRuleKind.NeverAllow, actionType, tenantId);
	},
);

Given(
	"a bot proposes a structured consequential operation {string} with:",
	async function (this: ChatticusWorld, actionType: string, table: DataTable) {
		const args = tableAsMap(table);
		this.lastOperationProposal = await policyControlFor(this)
			.approvalBinding(POLICY_KERNEL_TENANT)
			.proposeStructuredOperation(actionType, args["destination"], args["payload"]);
	},
);

When("the user approves that operation", async function (this: ChatticusWorld) {
	assert.ok(this.lastOperationProposal !== null, "no operation was proposed");
	this.lastApprovedOperation = await policyControlFor(this)
		.approvalBinding(POLICY_KERNEL_TENANT)
		.approveOperation(this.lastOperationProposal);
});

When(
	"the worker executes the approved operation with target-system evidence {string}",
	async function (this: ChatticusWorld, evidence: string) {
		assert.ok(this.lastApprovedOperation !== null, "no operation was approved");
		assert.ok(this.lastOperationProposal !== null, "no operation was proposed");
		this.lastBoundExecution = await policyControlFor(this).executeApprovedStructuredOperation(
			POLICY_KERNEL_TENANT,
			POLICY_KERNEL_TURN,
			this.lastApprovedOperation,
			this.lastOperationProposal.operation,
			evidence,
		);
		this.recordedCompletionEvidence = this.lastBoundExecution.completionEvidence;
	},
);

When(
	"the worker attempts to execute {string} with:",
	async function (this: ChatticusWorld, actionType: string, table: DataTable) {
		assert.ok(this.lastApprovedOperation !== null, "no operation was approved");
		const args = tableAsMap(table);
		this.lastBoundExecution = await policyControlFor(this).executeApprovedStructuredOperation(
			POLICY_KERNEL_TENANT,
			POLICY_KERNEL_TURN,
			this.lastApprovedOperation,
			{ actionType, destination: args["destination"], payload: args["payload"] },
			"smtp-250",
		);
	},
);

Then("only the reviewed destination and payload may execute", function (this: ChatticusWorld) {
	assert.ok(this.lastBoundExecution !== null, "nothing was executed");
	assert.equal(this.lastBoundExecution.executed, true);
	assert.equal(this.lastBoundExecution.requiresNewApproval, false);
});

Then("changing the destination requires a new approval", function (this: ChatticusWorld) {
	assert.ok(this.lastBoundExecution !== null, "nothing was executed");
	assert.equal(this.lastBoundExecution.executed, false);
	assert.equal(this.lastBoundExecution.reason, DESTINATION_CHANGED);
	assert.equal(this.lastBoundExecution.requiresNewApproval, true);
});

Then("changing the payload requires a new approval", function (this: ChatticusWorld) {
	assert.ok(this.lastBoundExecution !== null, "nothing was executed");
	assert.equal(this.lastBoundExecution.executed, false);
	assert.equal(this.lastBoundExecution.reason, PAYLOAD_CHANGED);
	assert.equal(this.lastBoundExecution.requiresNewApproval, true);
});

Then("completion evidence identifies the target-system result", function (this: ChatticusWorld) {
	assert.equal(this.recordedCompletionEvidence, "smtp-250");
});
