import assert from "node:assert/strict";
import { Given, When } from "@cucumber/cucumber";
import { ORGANIZATION_NAME_MAX_LENGTH } from "../../src/domain/creation-limits.ts";
import { recordResponse } from "../api.ts";
import { bearerFor, wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

Given(
	"a Cognito-verified HTTP front door with open signup and organization creation rate limit {int} per hour",
	async function (this: ChatticusWorld, limit: number) {
		await wireFrontDoor(this, {
			signupMode: "open",
			cognitoVerifier: true,
			organizationCreationRateLimit: limit,
		});
	},
);

When(
	"POST \\/organizations is called with a valid id token for {string} and an overlong organization name",
	async function (this: ChatticusWorld, email: string) {
		assert.ok(this.api);
		const overlongName = "A".repeat(ORGANIZATION_NAME_MAX_LENGTH + 1);
		this.createOrganizationResponse = await recordResponse(
			await this.api.post("/organizations", { headers: await bearerFor(this, email), body: { name: overlongName } }),
		);
		this.createdOrganizationName = overlongName;
	},
);
