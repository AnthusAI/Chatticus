import assert from "node:assert/strict";
import { Then } from "@cucumber/cucumber";
import { computerForOrganization } from "../../src/domain/computers.ts";
import { recordResponse } from "../api.ts";
import { memberGet } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

async function readHouseholdComputer(world: ChatticusWorld, tenantId: string, userId: string) {
	return recordResponse(await memberGet(world, `/orgs/${tenantId}/users/${userId}/computer`));
}

Then(
	"tenant {string} can read the household computer for user {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		const expected = await computerForOrganization(tenantId, { store: this.messagingStore() });
		const response = await readHouseholdComputer(this, tenantId, userId);
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.computer_id, expected.computerId);
		assert.equal(response.json.tenant_id, tenantId);
		assert.equal(response.json.stopped, true);
		assert.equal(response.json.host_start_generation, 0);
		const missing = await readHouseholdComputer(this, "other", userId);
		assert.equal(missing.status, 404, missing.text);
	},
);

Then(
	"tenant {string} household computer for user {string} reports host_start_generation {int}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, generation: number) {
		const response = await readHouseholdComputer(this, tenantId, userId);
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.host_start_generation, generation);
	},
);
