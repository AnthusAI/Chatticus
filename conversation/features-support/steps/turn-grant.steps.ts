import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { grantToPayload, householdConversationGrant, parseGrantTable } from "../../src/policy/capability-policy.ts";
import { PolicyControl } from "../../src/policy/policy-control.ts";
import { DynamoPolicyStore } from "../../src/store/policy-store.ts";
import { recordResponse } from "../api.ts";
import {
	activeTurnGrant,
	ensureMember,
	grantReplacementEvents,
	grantPayloadOfTable,
	grantTableOf,
	isHouseholdConversationGrant,
	memberHeadersFor,
	putActiveTurnGrant,
	sameGrant,
} from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { openChannelForTable } from "./message.steps.ts";

const BEYOND_STANDING_TABLE = {
	tools: "read_workspace, browse",
	origins: "https://docs.example.com",
	recipients: "",
	file_scopes: "/workspace",
	egress_classes: "approved_origin_fetch",
};

function policyControlOf(world: ChatticusWorld): PolicyControl {
	return new PolicyControl({
		policyStore: new DynamoPolicyStore(world.messagingTable.client, world.messagingTable.tableName),
		store: world.messagingStore(),
		clock: world.clock,
		ids: world.ids,
	});
}

function grantResponseOf(world: ChatticusWorld) {
	assert.ok(world.grantResponse, "No turn grant was put in this scenario.");
	return world.grantResponse;
}

Given(
	"tenant {string} user {string} is an enabled member",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		await ensureMember(this, tenantId, userId, "member");
	},
);

Given(
	"user {string} of tenant {string} has a grant standing ceiling of:",
	async function (this: ChatticusWorld, userId: string, tenantId: string, table: DataTable) {
		await ensureMember(this, tenantId, userId);
		await policyControlOf(this).setMemberGrantBoundsCeiling(tenantId, userId, { grantTable: grantTableOf(table) });
	},
);

When(
	"user {string} of tenant {string} opens a channel with bots:",
	async function (this: ChatticusWorld, userId: string, tenantId: string, table: DataTable) {
		await ensureMember(this, tenantId, userId);
		await openChannelForTable(this, tenantId, userId, table, {});
	},
);

Given(
	"user {string} of tenant {string} has started a turn with the household conversation grant",
	async function (this: ChatticusWorld, userId: string, tenantId: string) {
		const bot = [...(this.botsByName?.values() ?? [])][0];
		assert.ok(bot, "The scenario has no bot");
		const headers = await memberHeadersFor(this, tenantId, userId);
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const channel = await recordResponse(
			await this.api.post(`/orgs/${tenantId}/channels`, {
				headers,
				body: { user_id: userId, bot_ids: [bot.botId], kind: "direct", name: null },
			}),
		);
		assert.equal(channel.status, 200, channel.text);
		this.lastChannel = { channelId: channel.json.channel_id, tenantId };
		const posted = await recordResponse(
			await this.api.post(`/orgs/${tenantId}/channels/${channel.json.channel_id}/messages`, {
				headers,
				body: { author_kind: "human", author_id: userId, body: "hello", addressed_to_bot_id: bot.botId },
			}),
		);
		assert.equal(posted.status, 200, posted.text);
		this.lastTurnId = posted.json.turn_id;
		assert.ok(isHouseholdConversationGrant(await activeTurnGrant(this)), "The turn did not start with the household grant");
	},
);

When(
	"user {string} of tenant {string} replaces the active turn grant with:",
	async function (this: ChatticusWorld, userId: string, tenantId: string, table: DataTable) {
		const values = grantTableOf(table);
		this.lastGrantTable = values;
		await putActiveTurnGrant(this, await memberHeadersFor(this, tenantId, userId), grantPayloadOfTable(values), tenantId);
	},
);

When(
	"user {string} of tenant {string} replaces the active turn grant with tools beyond that standing",
	async function (this: ChatticusWorld, userId: string, tenantId: string) {
		await putActiveTurnGrant(
			this,
			await memberHeadersFor(this, tenantId, userId),
			grantPayloadOfTable(BEYOND_STANDING_TABLE),
			tenantId,
		);
	},
);

When("an unauthenticated caller PUTs the active turn grant on the user route", async function (this: ChatticusWorld) {
	await putActiveTurnGrant(this, {}, grantToPayload(householdConversationGrant()));
});

When(
	"the registered worker puts a turn grant for the active turn over HTTP:",
	async function (this: ChatticusWorld, table: DataTable) {
		const token = [...this.workerTokens.values()].at(-1);
		assert.ok(token, "No worker is registered in this scenario.");
		await putActiveTurnGrant(this, { Authorization: `Bearer ${token}` }, grantPayloadOfTable(grantTableOf(table)));
	},
);

When(
	"user {string} of tenant {string} PUTs a turn grant over HTTP for turn {string}:",
	async function (this: ChatticusWorld, userId: string, tenantId: string, turnId: string, table: DataTable) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		this.grantResponse = await recordResponse(
			await this.api.put(`/orgs/${tenantId}/turns/${turnId}/grant`, {
				headers: await memberHeadersFor(this, tenantId, userId),
				body: grantPayloadOfTable(grantTableOf(table)),
			}),
		);
	},
);

Then("the turn grant HTTP response has status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(grantResponseOf(this).status, status, grantResponseOf(this).text);
});

Then("the active turn carries the household conversation grant", async function (this: ChatticusWorld) {
	assert.ok(isHouseholdConversationGrant(await activeTurnGrant(this)), "The active turn does not carry the household grant");
});

Then("the active turn still carries the household conversation grant", async function (this: ChatticusWorld) {
	assert.ok(isHouseholdConversationGrant(await activeTurnGrant(this)), "The active turn lost the household grant");
});

Then("the active turn has no task grant", async function (this: ChatticusWorld) {
	assert.equal(await activeTurnGrant(this), null);
});

Then("the active turn grant is exactly that table", async function (this: ChatticusWorld) {
	assert.ok(this.lastGrantTable, "No grant table was put in this scenario.");
	const grant = await activeTurnGrant(this);
	assert.ok(grant, "The active turn carries no grant");
	assert.ok(sameGrant(grant, parseGrantTable(this.lastGrantTable)), JSON.stringify(grantToPayload(grant)));
});

Then("the active turn grant does not include tool {string}", async function (this: ChatticusWorld, tool: string) {
	const grant = await activeTurnGrant(this);
	assert.ok(grant, "The active turn carries no grant");
	assert.ok(!grant.tools.has(tool), `The grant includes ${tool}`);
});

Then("the active turn grant includes tool {string}", async function (this: ChatticusWorld, tool: string) {
	const grant = await activeTurnGrant(this);
	assert.ok(grant, "The active turn carries no grant");
	assert.ok(grant.tools.has(tool), `The grant does not include ${tool}`);
});

Then("the active turn grant has no tools", async function (this: ChatticusWorld) {
	const grant = await activeTurnGrant(this);
	assert.ok(grant, "The active turn carries no grant");
	assert.equal(grant.tools.size, 0);
});

Then(
	"the turn journal records a grant replacement by user {string}",
	async function (this: ChatticusWorld, userId: string) {
		const events = await grantReplacementEvents(this);
		assert.ok(events.length > 0, "expected a turn.grant.replaced journal event");
		const body = JSON.parse(events.at(-1)!.body);
		assert.equal(body.actor_user_id, userId);
		assert.ok(Array.isArray(body.tools));
	},
);

Then("the turn journal does not record a grant replacement", async function (this: ChatticusWorld) {
	assert.deepEqual(await grantReplacementEvents(this), []);
});
