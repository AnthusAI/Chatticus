import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { computerForOrganization } from "../../src/domain/computers.ts";
import { recordResponse } from "../api.ts";
import { actionStoreOf } from "../computer-support.ts";
import { computerScenarioOf, hostNamed, registerHost, workTurn } from "../computer-scenario.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { memberGet } from "../org-user-client.ts";
import { wireFrontDoor } from "../front-door.ts";
import { readTurnEvents } from "./model.steps.ts";
import { askBot } from "./model-tool-loop-sinks.steps.ts";
import type { ChatticusWorld } from "../world.ts";

function botOf(world: ChatticusWorld, name: string): { botId: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

/** The host of one organization's computer, registered on first use. */
async function hostOf(world: ChatticusWorld, tenantId: string) {
	const workerId = `host-${tenantId}`;
	return computerScenarioOf(world).hosts.get(workerId) ?? (await registerHost(world, tenantId, workerId, "local"));
}

/**
 * A bot works one request through the computer end to end: the member asks, the bot's turn parks on its computer action,
 * the organization's host runs the action and posts the result, and the bot's next turn attempt finishes.
 *
 * @returns The tool result the bot's turn recorded.
 */
async function useComputer(world: ChatticusWorld, botName: string, message: string): Promise<Record<string, any>> {
	const bot = botOf(world, botName);
	const openChannel = world.lastChannel;
	await askBot(world, botName, message);
	world.lastChannel = openChannel;
	const host = await hostOf(world, bot.tenantId);
	assert.equal(await workTurn(world, botName), "parked");
	const action = await host.runNextAction();
	assert.ok(action, "The host found no computer action to run.");
	const stored = await actionStoreOf(world).get(bot.tenantId, action.action_id);
	assert.ok(stored);
	assert.equal(stored.tenantId, bot.tenantId);
	assert.equal(
		stored.computerId,
		(await computerForOrganization(bot.tenantId, { store: world.messagingStore() })).computerId,
		"the action was not routed to the organization computer",
	);
	computerScenarioOf(world).lastActionByBot.set(botName, stored);
	assert.equal(await workTurn(world, botName), "done");
	assert.ok(world.lastTurnId, "The request started no turn.");
	const results = (await readTurnEvents(world, bot.tenantId, world.lastTurnId)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, 1);
	return results[0]!;
}

When(
	"bot {string} writes {string} containing {string} on the computer",
	async function (this: ChatticusWorld, botName: string, file: string, content: string) {
		await useComputer(this, botName, `write workspace file /workspace/${file} containing ${content}`);
	},
);

Then(
	"bot {string} can read {string} as {string} from the computer",
	async function (this: ChatticusWorld, botName: string, file: string, content: string) {
		const result = await useComputer(this, botName, `read workspace file /workspace/${file}`);
		assert.equal(result.body, content);
	},
);

Then(
	"bot {string} cannot read {string} from its computer",
	async function (this: ChatticusWorld, botName: string, file: string) {
		const bot = botOf(this, botName);
		const state = computerScenarioOf(this);
		const otherTenants = [...state.hosts.values()].filter((host) => host.tenantId !== bot.tenantId);
		assert.ok(otherTenants.length > 0, "no host of another organization is registered to attempt the claim");
		const ownerActionComputerIds = [...state.lastActionByBot.values()]
			.filter((action) => action.tenantId !== bot.tenantId)
			.map((action) => action.computerId);
		assert.ok(ownerActionComputerIds.length > 0, "no action of another organization ran in this scenario");
		const openChannel = this.lastChannel;
		await askBot(this, botName, `read workspace file /workspace/${file}`);
		this.lastChannel = openChannel;
		assert.equal(await workTurn(this, botName), "parked");
		for (const foreignHost of otherTenants) {
			assert.equal(await foreignHost.claim(), null, "a host of another organization claimed this organization's action");
			const intruder = await recordResponse(
				await this.api!.post(`/orgs/${bot.tenantId}/host/actions/claim`, {
					headers: await foreignHost.bearerHeaders(),
					body: {},
				}),
			);
			assert.ok(intruder.status === 401 || intruder.status === 403, `cross-organization claim answered ${intruder.status}`);
		}
		const host = await hostOf(this, bot.tenantId);
		const action = await host.runNextAction();
		assert.ok(action, "The host found no computer action to run.");
		const stored = await actionStoreOf(this).get(bot.tenantId, action.action_id);
		assert.ok(stored);
		assert.ok(!ownerActionComputerIds.includes(stored.computerId), "the two organizations share one computer");
		assert.equal(await workTurn(this, botName), "done");
		const results = (await readTurnEvents(this, bot.tenantId, this.lastTurnId!)).filter((event) => event.kind === "tool.result");
		assert.equal(results.length, 1);
		assert.ok(String(results[0]!.body).includes("no such file"), String(results[0]!.body));
	},
);

Then("both bots use the same computer", async function (this: ChatticusWorld) {
	const actions = [...computerScenarioOf(this).lastActionByBot.values()];
	assert.equal(actions.length, 2);
	const computer = await computerForOrganization(actions[0]!.tenantId, { store: this.messagingStore() });
	assert.deepEqual(
		actions.map((action) => action.computerId),
		[computer.computerId, computer.computerId],
	);
});

async function memoryOf(world: ChatticusWorld, botName: string): Promise<Record<string, string>> {
	const bot = botOf(world, botName);
	const response = await recordResponse(await memberGet(world, `/orgs/${bot.tenantId}/bots/${bot.botId}`));
	assert.equal(response.status, 200, response.text);
	return response.json.memory;
}

Then("bot {string} does not remember {string}", async function (this: ChatticusWorld, botName: string, key: string) {
	assert.equal((await memoryOf(this, botName))[key], undefined);
});

Then(
	"bot {string} has memory {string} as {string}",
	async function (this: ChatticusWorld, botName: string, key: string, value: string) {
		assert.equal((await memoryOf(this, botName))[key], value);
	},
);

When("the control plane is recycled onto the same messaging store", async function (this: ChatticusWorld) {
	this.scenarioMessagingStore = this.createMessagingStore();
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
});

/** The first request the model received for the scenario's turn; the turn runs when it has not yet, because a model request exists only once it has. */
async function firstModelRequest(world: ChatticusWorld, botName: string): Promise<string> {
	const scripted = modelScenarioOf(world).scripted;
	if (scripted.callCount === 0) {
		assert.equal(await workTurn(world, botName), "done");
	}
	return scripted.requests[0]!;
}

Then(
	"the turn prompt contains memory {string} as {string}",
	async function (this: ChatticusWorld, key: string, value: string) {
		const request = await firstModelRequest(this, "Researcher");
		assert.ok(request.includes(`memory ${key}: ${value}`), request);
	},
);

Then("the turn prompt contains channel text {string}", async function (this: ChatticusWorld, text: string) {
	assert.ok((await firstModelRequest(this, "Researcher")).includes(text));
});
