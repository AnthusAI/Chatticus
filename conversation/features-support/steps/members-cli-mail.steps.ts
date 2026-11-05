import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { identityOfPerson, tenantIdOfOrganization } from "../bot-board-support.ts";
import { requiredChannelsRuntime } from "../channels-support.ts";
import { parseConfirmationLine, runMembersCliProcess } from "../members-cli-process.ts";
import type { ChatticusWorld } from "../world.ts";

function botIdNamed(world: ChatticusWorld, botName: string): string {
	const bot = world.botsByName?.get(botName);
	assert.ok(bot, `The scenario has no bot ${botName}`);
	return bot.botId;
}

When(
	"the members CLI sets the mail handle {string} for {string}",
	async function (this: ChatticusWorld, handle: string, organization: string) {
		await runMembersCliProcess(this, ["set-mail-handle", tenantIdOfOrganization(organization), handle, "--yes"]);
	},
);

When(
	"the members CLI sets the mail handle {string} for {string} without confirmation",
	async function (this: ChatticusWorld, handle: string, organization: string) {
		await runMembersCliProcess(this, ["set-mail-handle", tenantIdOfOrganization(organization), handle]);
	},
);

When(
	"the members CLI binds the email address of the bot {string} in {string}",
	async function (this: ChatticusWorld, botName: string, organization: string) {
		await runMembersCliProcess(this, [
			"bind-channel",
			tenantIdOfOrganization(organization),
			"--provider",
			"email",
			"--bot-id",
			botIdNamed(this, botName),
			"--yes",
		]);
	},
);

When(
	"the members CLI links the email address {string} to {string} in {string}",
	async function (this: ChatticusWorld, address: string, person: string, organization: string) {
		const tenantId = tenantIdOfOrganization(organization);
		await runMembersCliProcess(this, [
			"link-identity",
			tenantId,
			"--provider",
			"email",
			"--external-id",
			address,
			"--user-id",
			identityOfPerson(tenantId, person).userId,
			"--yes",
		]);
	},
);

Then(
	"the members CLI reports the mail handle {string} for {string}",
	function (this: ChatticusWorld, handle: string, organization: string) {
		const result = this.membersCliResult;
		assert.ok(result, "the members CLI has not run in this scenario");
		assert.equal(result.exitCode, 0, result.stderr);
		const confirmation = parseConfirmationLine(result.stdout, "mail-handle-set");
		assert.equal(confirmation.tenant_id, tenantIdOfOrganization(organization));
		assert.equal(confirmation.mail_handle, handle);
	},
);

Then("the members CLI reports the bound address {string}", function (this: ChatticusWorld, address: string) {
	const result = this.membersCliResult;
	assert.ok(result, "the members CLI has not run in this scenario");
	assert.equal(result.exitCode, 0, result.stderr);
	assert.equal(parseConfirmationLine(result.stdout, "channel-bound").route_key, address);
});

Then(
	"the members CLI reports the linked identity {string} for {string} in {string}",
	function (this: ChatticusWorld, externalId: string, person: string, organization: string) {
		const result = this.membersCliResult;
		assert.ok(result, "the members CLI has not run in this scenario");
		assert.equal(result.exitCode, 0, result.stderr);
		const tenantId = tenantIdOfOrganization(organization);
		const confirmation = parseConfirmationLine(result.stdout, "identity-linked");
		assert.equal(confirmation.external_id, externalId);
		assert.equal(confirmation.user_id, identityOfPerson(tenantId, person).userId);
	},
);

Then("the members CLI refused the command with the reason {string}", function (this: ChatticusWorld, reason: string) {
	const result = this.membersCliResult;
	assert.ok(result, "the members CLI has not run in this scenario");
	assert.equal(result.exitCode, 1, result.stderr);
	assert.ok(result.stderr.includes(reason), `stderr does not name ${reason}: ${result.stderr}`);
});

Then(
	"the organization {string} has an enabled email binding at {string} for the bot {string}",
	async function (this: ChatticusWorld, organization: string, address: string, botName: string) {
		const bindings = await requiredChannelsRuntime(this).store.listBindings(tenantIdOfOrganization(organization));
		const found = bindings.find((binding) => binding.routeKey === address);
		assert.ok(found, `no binding at ${address}`);
		assert.equal(found.enabled, true);
		assert.equal(found.botId, botIdNamed(this, botName));
	},
);

Then("the organization {string} has no mail handle", async function (this: ChatticusWorld, organization: string) {
	const settings = await requiredChannelsRuntime(this).store.getSettings(tenantIdOfOrganization(organization));
	assert.equal(settings.mailHandle, null);
});

