import assert from "node:assert/strict";
import { Given, Then, When, defineParameterType, type DataTable } from "@cucumber/cucumber";
import { createApp } from "../../src/http/app.ts";
import type { ChatticusWorld } from "../world.ts";

const WAITLIST_SAFE_ROUTE_PATHS = ["/me"];
const NO_PRINCIPAL_ROUTES = ["/auth/callback"];

defineParameterType({
	name: "path",
	regexp: /"([^"]+)"/,
	transformer: (s: string) => s,
});

function orgPath(tenantId: string, path: string): string {
	return `/orgs/${tenantId}${path}`;
}

Given("an empty control plane", async function (this: ChatticusWorld) {
	this.api = null;
});

Given('tenant {string} user {string} has a bot named {string}', async function (
	this: ChatticusWorld,
	tenantId: string,
	userId: string,
	botName: string,
) {
	if (!this.botsById) {
		this.botsById = new Map();
	}
	const botId = this.ids.next();
	this.botsById.set(botId, { botId, name: botName, tenantId });
	this.botsByName = this.botsByName || new Map();
	this.botsByName.set(botName, { botId, name: botName, tenantId });
});

When(
	'the front door receives POST \\/orgs\\/{word}\\/channels for user {string} with bots:',
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const botNames: string[] = [];
		if (table) {
			const rows = table.rows();
			for (const row of rows) {
				botNames.push(row[0]);
			}
		}

		const botIds: string[] = [];
		if (this.botsByName) {
			for (const name of botNames) {
				const bot = this.botsByName.get(name);
				assert.ok(bot, `Bot ${name} not found`);
				botIds.push(bot.botId);
			}
		}

		if (!this.api) {
			this.api = new (await import("../api.ts")).ApiClient(
				createApp({
					clock: this.clock,
					ids: this.ids,
					store: {},
					invokeKey: null,
				}),
			);
		}

		const response = await this.api.post(orgPath(tenantId, "/channels"), {
			body: {
				userId,
				botIds,
				kind: botIds.length === 1 ? "direct" : "named",
				name: botIds.length === 1 ? null : "Scenario channel",
			},
		});

		if (response.status === 200) {
			const data = await response.json();
			this.lastChannel = { channelId: data.channel_id, tenantId };
			this.lastHttpResponse = new Response(JSON.stringify(data), { status: 200 });
		} else {
			this.lastHttpResponse = response;
		}
	},
);

Then('the channel response has tenant_id {string}', async function (this: ChatticusWorld, expectedTenantId: string) {
	const response = this.lastHttpResponse;
	assert.ok(response, "No last HTTP response");
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.tenant_id, expectedTenantId);
});

When(
	'the front door receives GET \\/orgs\\/{word}\\/users\\/{word}\\/bots with header X-Tenant-Id {word}',
	async function (this: ChatticusWorld, tenantId: string, userId: string, headerTenant: string) {
		if (!this.api) {
			this.api = new (await import("../api.ts")).ApiClient(
				createApp({
					clock: this.clock,
					ids: this.ids,
					store: {},
					invokeKey: null,
				}),
			);
		}

		const response = await this.api.get(orgPath(tenantId, `/users/${userId}/bots`), {
			headers: { "X-Tenant-Id": headerTenant },
		});

		this.lastHttpResponse = response;
	},
);

Then("the front door rejects X-Tenant-Id", async function (this: ChatticusWorld) {
	const response = this.lastHttpResponse;
	assert.ok(response, "No last HTTP response");
	assert.equal(response.status, 400);
	const data = await response.json();
	assert.ok(data.detail?.includes("X-Tenant-Id"), `Expected X-Tenant-Id in detail: ${data.detail}`);
});

Given(
	'tenant {string} user {string} has opened a channel with bots:',
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const botNames: string[] = [];
		if (table) {
			const rows = table.rows();
			for (const row of rows) {
				botNames.push(row[0]);
			}
		}

		const botIds: string[] = [];
		if (this.botsByName) {
			for (const name of botNames) {
				const bot = this.botsByName.get(name);
				assert.ok(bot, `Bot ${name} not found`);
				botIds.push(bot.botId);
			}
		}

		if (!this.api) {
			this.api = new (await import("../api.ts")).ApiClient(
				createApp({
					clock: this.clock,
					ids: this.ids,
					store: {},
					invokeKey: null,
				}),
			);
		}

		const response = await this.api.post(orgPath(tenantId, "/channels"), {
			body: {
				userId,
				botIds,
				kind: botIds.length === 1 ? "direct" : "named",
				name: botIds.length === 1 ? null : "Scenario channel",
			},
		});

		assert.equal(response.status, 200);
		const data = await response.json();
		this.lastChannel = { channelId: data.channel_id, tenantId };
	},
);

When(
	'tenant {string} posts {string} on the channel via org path {string}',
	async function (this: ChatticusWorld, tenantId: string, body: string, orgTenant: string) {
		const channel = this.lastChannel;
		assert.ok(channel, "No channel has been opened");

		if (!this.api) {
			this.api = new (await import("../api.ts")).ApiClient(
				createApp({
					clock: this.clock,
					ids: this.ids,
					store: {},
					invokeKey: null,
				}),
			);
		}

		const response = await this.api.post(`/orgs/${orgTenant}/channels/${channel.channelId}/messages`, {
			body: {
				authorKind: "human",
				authorId: "intruder",
				body,
			},
		});

		if (response.status === 403) {
			const data = await response.json();
			this.messageError = new Error(data.detail);
		} else if (response.status >= 400) {
			this.messageError = response;
		} else {
			this.messageError = null;
			const data = await response.json();
			this.lastTurnId = data.turn_id;
		}
	},
);

Then("posting fails because the tenant does not match", async function (this: ChatticusWorld) {
	assert.ok(this.messageError, "Expected posting to fail");
	if (this.messageError instanceof Error) {
		assert.ok(this.messageError.message.includes("tenant"));
	}
});

Then("the channel has {int} messages", async function (this: ChatticusWorld, count: number) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel");

	if (!this.api) {
		this.api = new (await import("../api.ts")).ApiClient(
			createApp({
				clock: this.clock,
				ids: this.ids,
				store: {},
				invokeKey: null,
			}),
		);
	}

	const response = await this.api.get(orgPath(channel.tenantId, `/channels/${channel.channelId}/messages`));
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.messages?.length || 0, count);
});

Given(
	'a front door serving named environment {string} with HTTP',
	async function (this: ChatticusWorld, environment: string) {
		this.environment = environment;
		this.api = new (await import("../api.ts")).ApiClient(
			createApp({
				clock: this.clock,
				ids: this.ids,
				store: {},
				invokeKey: null,
				environment,
			}),
		);
	},
);

Then('GET \\/health reports environment {string}', async function (this: ChatticusWorld, expectedEnvironment: string) {
	assert.ok(this.api, "No API client");
	const response = await this.api.get("/health");
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.status, "ok");
	assert.equal(data.environment, expectedEnvironment);
});

Then('{path} is outside the principal marker system', function (this: ChatticusWorld, path: string) {
	assert.ok(NO_PRINCIPAL_ROUTES.includes(path), `Path ${path} is not outside the principal system`);
});

Then('{path} is a named waitlist-safe route', function (this: ChatticusWorld, path: string) {
	assert.ok(WAITLIST_SAFE_ROUTE_PATHS.includes(path), `Path ${path} is not a waitlist-safe route`);
});
