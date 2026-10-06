import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { memberGet } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

const rosters = new WeakMap<ChatticusWorld, RecordedResponse>();

When(
	"the web UI requests the bot roster for tenant {string} user {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		rosters.set(this, await recordResponse(await memberGet(this, `/orgs/${tenantId}/users/${userId}/bots`)));
	},
);

Then("the web UI bot roster is empty", function (this: ChatticusWorld) {
	const response = rosters.get(this);
	assert.ok(response, "The web UI requested no roster.");
	assert.equal(response.status, 200, response.text);
	assert.deepEqual(response.json.bots, []);
});
