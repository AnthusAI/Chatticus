import assert from "node:assert/strict";
import { Given } from "@cucumber/cucumber";
import type { ChatticusWorld } from "../world.ts";

Given("a Cognito-verified HTTP front door with open signup and organization creation rate limit {int} per hour", async function (
	this: ChatticusWorld,
	limit: number,
) {
	this.environment = "test";
	this.messageError = null;
});

Given("{string} has created organization {string} via the HTTP front door", async function (
	this: ChatticusWorld,
	email: string,
	name: string,
) {
	const identity = await this.ids.next();
	const org = {
		tenantId: identity,
		name,
		status: "pending" as const,
		ownerUserId: identity,
		createdAt: this.now,
		awsAccountId: null,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: null,
		monthlyAwsSpendCeilingUsd: null,
	};
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, org);
});
