import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import {
	SPEND_CEILING_EXCEEDED_REASON,
	SPEND_CEILING_METER_UNAVAILABLE_REASON,
} from "../../src/domain/organization-spend.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { utcDayOf } from "../../src/budget/calendar.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { bearerFor } from "../front-door.ts";
import {
	ABOVE_CEILING_MONTH_TO_DATE_USD,
	DEFAULT_CEILING_USD,
	MEMBER_EMAIL,
	OWNER_EMAIL,
	provisionEnabledOrganizationWithCeiling,
	rollUpToday,
	spendScenario,
	spendToday,
	storedOrganization,
} from "../spend-ceiling.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const BOT_NAME = "Researcher";
const CHANNEL_MESSAGE = "Budget pause check";

function api(world: ChatticusWorld) {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	return world.api;
}

async function ensureMember(world: ChatticusWorld): Promise<string> {
	const state = spendScenario(world);
	if (state.memberUserId !== null) {
		return state.memberUserId;
	}
	const deps = { store: world.messagingStore(), clock: world.clock, ids: world.ids };
	const member = await kernel.signIn(MEMBER_EMAIL, deps);
	const invitation = await kernel.inviteByEmail(state.tenantId, state.ownerUserId, MEMBER_EMAIL, deps);
	await kernel.acceptInvitation(invitation.invitationId, member, deps);
	state.memberUserId = member.userId;
	return member.userId;
}

async function patchCeiling(world: ChatticusWorld, email: string, amount: string): Promise<RecordedResponse> {
	const state = spendScenario(world);
	const response = await recordResponse(
		await api(world).patch(`/orgs/${state.tenantId}/monthly-aws-spend-ceiling`, {
			headers: await bearerFor(world, email),
			body: { monthly_aws_spend_ceiling_usd: amount },
		}),
	);
	state.ceilingResponse = response;
	return response;
}

async function readMe(world: ChatticusWorld, email: string): Promise<void> {
	world.meResponse = await recordResponse(await api(world).get("/me", { headers: await bearerFor(world, email) }));
}

function meOrganization(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.meResponse, "GET /me has not been called in this scenario");
	assert.equal(world.meResponse.status, 200, world.meResponse.text);
	const organizations = world.meResponse.json.organizations;
	assert.equal(organizations.length, 1, world.meResponse.text);
	return organizations[0];
}

Given("an enabled organization with a monthly spend ceiling", async function (this: ChatticusWorld) {
	await provisionEnabledOrganizationWithCeiling(this);
});

Given(
	"an enabled organization whose month-to-date spend has passed its ceiling",
	async function (this: ChatticusWorld) {
		await provisionEnabledOrganizationWithCeiling(this);
		await spendToday(this, ABOVE_CEILING_MONTH_TO_DATE_USD);
	},
);

Given("month-to-date spend rollup for today is pending", async function (this: ChatticusWorld) {
	this.costExplorer.setDayPending(this.budgetEnvironment, utcDayOf(this.clock.now()));
	await rollUpToday(this);
});

Given("month-to-date spend rollup for today could not be read", async function (this: ChatticusWorld) {
	this.costExplorer.setTenantTagActive(false);
	await rollUpToday(this);
});

Given("the organization has a channel with a readable message", async function (this: ChatticusWorld) {
	const state = spendScenario(this);
	const memberUserId = await ensureMember(this);
	const headers = await bearerFor(this, MEMBER_EMAIL);
	const bot = await recordResponse(
		await api(this).post(`/orgs/${state.tenantId}/bots`, { headers, body: { name: BOT_NAME } }),
	);
	assert.equal(bot.status, 200, bot.text);
	const channel = await recordResponse(
		await api(this).post(`/orgs/${state.tenantId}/channels`, {
			headers,
			body: { user_id: memberUserId, bot_ids: [bot.json.bot_id], kind: "direct", name: null },
		}),
	);
	assert.equal(channel.status, 200, channel.text);
	const message = await recordResponse(
		await api(this).post(`/orgs/${state.tenantId}/channels/${channel.json.channel_id}/messages`, {
			headers,
			body: {
				author_kind: "human",
				author_id: memberUserId,
				body: CHANNEL_MESSAGE,
				addressed_to_bot_id: null,
				enqueue_turn: false,
			},
		}),
	);
	assert.equal(message.status, 200, message.text);
	state.channelId = channel.json.channel_id;
});

When("its owner sets a higher ceiling", async function (this: ChatticusWorld) {
	const response = await patchCeiling(this, OWNER_EMAIL, "500.00");
	assert.equal(response.status, 200, response.text);
});

Then("the organization carries the new ceiling", async function (this: ChatticusWorld) {
	const ceiling = (await storedOrganization(this)).monthlyAwsSpendCeilingUsd;
	assert.ok(ceiling !== null && ceiling.equals(Decimal.parse("500.00")), String(ceiling));
});

When("a member who is not an owner attempts to change it", async function (this: ChatticusWorld) {
	await ensureMember(this);
	await patchCeiling(this, MEMBER_EMAIL, "500.00");
});

When("its owner submits a ceiling of {string}", async function (this: ChatticusWorld, amount: string) {
	await patchCeiling(this, OWNER_EMAIL, amount);
});

Then("the change is refused", function (this: ChatticusWorld) {
	const response = spendScenario(this).ceilingResponse;
	assert.ok(response, "No ceiling change was attempted");
	assert.equal(response.status, 403, response.text);
});

Then("the change is rejected as invalid", function (this: ChatticusWorld) {
	const response = spendScenario(this).ceilingResponse;
	assert.ok(response, "No ceiling change was attempted");
	assert.equal(response.status, 400, response.text);
});

Then("the ceiling is unchanged", async function (this: ChatticusWorld) {
	const ceiling = (await storedOrganization(this)).monthlyAwsSpendCeilingUsd;
	assert.ok(ceiling !== null && ceiling.equals(Decimal.parse(DEFAULT_CEILING_USD)), String(ceiling));
});

When("the owner opens the workspace", async function (this: ChatticusWorld) {
	await readMe(this, OWNER_EMAIL);
});

When("a member opens the workspace", async function (this: ChatticusWorld) {
	const state = spendScenario(this);
	const memberUserId = await ensureMember(this);
	await readMe(this, MEMBER_EMAIL);
	state.channelsResponse = await recordResponse(
		await api(this).get(`/orgs/${state.tenantId}/users/${memberUserId}/channels`, {
			headers: await bearerFor(this, MEMBER_EMAIL),
		}),
	);
});

Then("the workspace data says the signed-in user is an owner", function (this: ChatticusWorld) {
	assert.equal(meOrganization(this).role, "owner");
});

Then("the workspace data says the signed-in user is a member", function (this: ChatticusWorld) {
	assert.equal(meOrganization(this).role, "member");
});

Then("the workspace data shows the ceiling 250.00", function (this: ChatticusWorld) {
	const shown = meOrganization(this).monthly_aws_spend_ceiling_usd;
	assert.equal(typeof shown, "string");
	assert.ok(Decimal.parse(shown).equals(Decimal.parse("250.00")), shown);
});

Then("the workspace data does not show the ceiling", function (this: ChatticusWorld) {
	assert.equal(meOrganization(this).monthly_aws_spend_ceiling_usd, null);
});

Then("they read their channels and see why work is paused", function (this: ChatticusWorld) {
	const organization = meOrganization(this);
	assert.equal(organization.computer_work_paused, true);
	assert.equal(organization.computer_work_paused_reason, SPEND_CEILING_EXCEEDED_REASON);
	const state = spendScenario(this);
	assert.ok(state.channelsResponse, "The member did not read their channels");
	assert.equal(state.channelsResponse.status, 200, state.channelsResponse.text);
	const channelIds = state.channelsResponse.json.channels.map((channel: { channel_id: string }) => channel.channel_id);
	assert.ok(state.channelId !== null && channelIds.includes(state.channelId), JSON.stringify(channelIds));
});

Then("they see computer work paused for meter unavailability", function (this: ChatticusWorld) {
	const organization = meOrganization(this);
	assert.equal(organization.computer_work_paused, true);
	assert.equal(organization.computer_work_paused_reason, SPEND_CEILING_METER_UNAVAILABLE_REASON);
	const state = spendScenario(this);
	assert.ok(state.channelsResponse, "The member did not read their channels");
	assert.equal(state.channelsResponse.status, 200, state.channelsResponse.text);
});

Then("the organization status is still enabled", async function (this: ChatticusWorld) {
	assert.equal((await storedOrganization(this)).status, "enabled");
	assert.equal(meOrganization(this).status, "enabled");
});
