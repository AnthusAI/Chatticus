import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { evaluateModelToolRequest, type ToolGateVerdict } from "../../src/pi/gate.ts";
import { policyControlFor } from "../policy-control.ts";
import type { ChatticusWorld } from "../world.ts";

const verdicts = new WeakMap<ChatticusWorld, ToolGateVerdict>();

When(
	"the worker reads workspace file {string} for tenant {string} turn {string}",
	async function (this: ChatticusWorld, path: string, tenantId: string, turnId: string) {
		const userId = [...this.botCreatorUserIds.values()][0] ?? "ryan";
		const policy = policyControlFor(this);
		const store = this.turnControlStore();
		verdicts.set(
			this,
			await evaluateModelToolRequest(
				{
					now: () => this.clock.now(),
					readGrant: () => store.getGrant(tenantId, turnId),
					resolveStanding: (actionType) => policy.memberStandingForUser(tenantId, userId, actionType),
				},
				"read_workspace",
				{ path },
			),
		);
	},
);

Then("the gated workspace read is denied", function (this: ChatticusWorld) {
	const verdict = verdicts.get(this);
	assert.ok(verdict, "No workspace read was attempted.");
	assert.equal(verdict.allowed, false);
});

Then("the gated workspace read is allowed", function (this: ChatticusWorld) {
	const verdict = verdicts.get(this);
	assert.ok(verdict, "No workspace read was attempted.");
	assert.deepEqual(verdict, { allowed: true });
});
