import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { ensureComputer, recordComputerCapabilityReady } from "../../src/domain/computers.ts";
import { scenarioTenantId } from "../computer-scenario.ts";
import type { ChatticusWorld } from "../world.ts";

const RACING_OWNER_ID = "owner-racing";
const RACING_DISPATCH_ID = "dispatch-landed-during-report";
const RACING_GENERATION = 1;

Given("the household computer has a live owner on its first host start generation", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	const tenantId = scenarioTenantId(this);
	const computer = await ensureComputer(tenantId, { store, ids: this.ids });
	await store.putComputer({ ...computer, hostStartGeneration: RACING_GENERATION, hostStartDispatchedGeneration: RACING_GENERATION });
	const consumed = await store.consumeOwnerBootstrap(tenantId, {
		ownerId: RACING_OWNER_ID,
		generation: RACING_GENERATION,
		protocolVersion: 1,
		startedAt: new Date(),
		credentialsExpireAt: new Date(Date.now() + 3600 * 1000),
	});
	assert.ok(consumed, "The owner bootstrap was not consumed.");
});

When("a dispatch is offered to the owner while a workspace readiness report is being recorded", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	const tenantId = scenarioTenantId(this);
	const readBeforeDispatch = store.getComputer.bind(store);
	let offered = false;
	store.getComputer = async (requestedTenantId: string) => {
		const computer = await readBeforeDispatch(requestedTenantId);
		if (!offered) {
			offered = true;
			const accepted = await store.offerOwnerDispatch(tenantId, RACING_OWNER_ID, null, {
				dispatchId: RACING_DISPATCH_ID,
				turnId: "turn-racing",
				actionId: "action-racing",
				attempt: 1,
				leaseExpiresAt: new Date(Date.now() + 60 * 1000),
			});
			assert.equal(accepted, true, "The dispatch was not accepted.");
		}
		return computer;
	};
	await recordComputerCapabilityReady(tenantId, "workspace", { store, ids: this.ids });
	store.getComputer = readBeforeDispatch;
});

Then("the computer is workspace ready and still holds that dispatch for the owner", async function (this: ChatticusWorld) {
	const computer = await this.messagingStore().getComputer(scenarioTenantId(this));
	assert.equal(computer?.workspaceReady, true);
	assert.equal(computer?.dispatchId, RACING_DISPATCH_ID);
	assert.equal(computer?.ownerId, RACING_OWNER_ID);
});
