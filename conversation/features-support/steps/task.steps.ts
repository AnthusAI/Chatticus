import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { setComputerStopped } from "../../src/domain/computers.ts";
import { TASK_TOOL_NAME } from "../../src/pi/task-tool.ts";
import type { Computer } from "../../src/store/codecs/computer.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { modelScenarioOf, runBotTurn } from "../executor-harness.ts";
import { ensureTestOrganization, memberGet, memberPost } from "../org-user-client.ts";
import { bearerFor, httpBaseUrl } from "../front-door.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import type { ChatticusWorld } from "../world.ts";
import { currentTurnOf, readTurnEvents } from "./model.steps.ts";
import { openChannelWithNamedBot, post } from "./message.steps.ts";

const HOUSEHOLD_USER = "ryan";

type TaskPayload = Record<string, any>;

type TaskScenario = {
	lastTask: TaskPayload | null;
	createdTaskIds: string[];
	toolResultBody: string | null;
	computerAtStop: Computer | null;
	httpResponse: RecordedResponse | null;
	otherTenantResponse: RecordedResponse | null;
	receivedMessage: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, TaskScenario>();

function scenarioOf(world: ChatticusWorld): TaskScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			lastTask: null,
			createdTaskIds: [],
			toolResultBody: null,
			computerAtStop: null,
			httpResponse: null,
			otherTenantResponse: null,
			receivedMessage: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

async function listTasksOver(world: ChatticusWorld, tenantId: string, userId: string): Promise<RecordedResponse> {
	return recordResponse(await memberGet(world, `/orgs/${tenantId}/users/${userId}/tasks`));
}

/** The task the bot's turn just stored, found through the list route by the identifiers not seen before. */
async function adoptNewTask(world: ChatticusWorld, tenantId: string): Promise<TaskPayload> {
	const scenario = scenarioOf(world);
	const listed = await listTasksOver(world, tenantId, HOUSEHOLD_USER);
	assert.equal(listed.status, 200, listed.text);
	const fresh = (listed.json.tasks as TaskPayload[]).filter((task) => !scenario.createdTaskIds.includes(task.task_id));
	assert.equal(fresh.length, 1, `Expected exactly one new task, found ${fresh.length}`);
	scenario.createdTaskIds.push(fresh[0]!.task_id);
	scenario.lastTask = fresh[0]!;
	return fresh[0]!;
}

async function readTask(world: ChatticusWorld, tenantId: string, taskId: string): Promise<TaskPayload> {
	const response = await recordResponse(await memberGet(world, `/orgs/${tenantId}/tasks/${taskId}`));
	assert.equal(response.status, 200, response.text);
	return response.json;
}

/**
 * Let a bot call the task tool the way a model does: the human posts to the bot, the scripted model answers with a
 * `task` tool call and then a plain answer, and the real executor runs the turn. Returns the text the model saw as the
 * tool's result.
 */
async function callTaskToolInTurn(world: ChatticusWorld, botName: string, args: Record<string, string>): Promise<string> {
	const bot = botNamed(world, botName);
	await openChannelWithNamedBot(world, bot.tenantId, HOUSEHOLD_USER, botName);
	await post(world, {
		authorKind: "human",
		authorId: HOUSEHOLD_USER,
		body: `Please use the task tool to ${args.action} a task.`,
		addressedToBotId: bot.botId,
	});
	modelScenarioOf(world).scripted.toolCall(TASK_TOOL_NAME, args).reply("The task tool has answered.");
	assert.equal(await runBotTurn(world, botName), "done");
	const events = await readTurnEvents(world, bot.tenantId, currentTurnOf(world));
	const call = events.find((event) => event.kind === "tool.call");
	assert.equal(call?.body, TASK_TOOL_NAME, "The turn did not call the task tool");
	const result = events.find((event) => event.kind === "tool.result" && event.action_id === call?.action_id);
	assert.ok(result, "The task tool call has no result in the turn");
	scenarioOf(world).toolResultBody = String(result.body);
	return String(result.body);
}

function lastTaskOf(world: ChatticusWorld): TaskPayload {
	const task = scenarioOf(world).lastTask;
	assert.ok(task, "The scenario has no task yet");
	return task;
}

function cellsOf(table: DataTable): string[] {
	return table
		.raw()
		.map((row) => (row[0] ?? "").trim())
		.filter((cell) => cell !== "");
}

Given("the household computer is stopped for task work", async function (this: ChatticusWorld) {
	const stopped = await setComputerStopped("anthus", true, { store: this.messagingStore(), ids: this.ids });
	assert.equal(stopped.stopped, true);
	scenarioOf(this).computerAtStop = stopped;
});

When(
	"bot {string} uses the task tool to create a task titled {string}",
	async function (this: ChatticusWorld, botName: string, title: string) {
		await callTaskToolInTurn(this, botName, { action: "create", title });
		await adoptNewTask(this, botNamed(this, botName).tenantId);
	},
);

Given(
	"bot {string} has an open task {string}",
	async function (this: ChatticusWorld, botName: string, title: string) {
		await callTaskToolInTurn(this, botName, { action: "create", title });
		await adoptNewTask(this, botNamed(this, botName).tenantId);
	},
);

When(
	"bot {string} tries to complete the task without evidence",
	async function (this: ChatticusWorld, botName: string) {
		await callTaskToolInTurn(this, botName, { action: "complete", task_id: lastTaskOf(this).task_id });
	},
);

When(
	"bot {string} completes the task with evidence {string}",
	async function (this: ChatticusWorld, botName: string, evidence: string) {
		await callTaskToolInTurn(this, botName, { action: "complete", task_id: lastTaskOf(this).task_id, evidence });
		const task = lastTaskOf(this);
		scenarioOf(this).lastTask = await readTask(this, task.tenant_id, task.task_id);
	},
);

When(
	"bot {string} closes the task with reason {string}",
	async function (this: ChatticusWorld, botName: string, reason: string) {
		await callTaskToolInTurn(this, botName, { action: "close", task_id: lastTaskOf(this).task_id, reason });
		const task = lastTaskOf(this);
		scenarioOf(this).lastTask = await readTask(this, task.tenant_id, task.task_id);
	},
);

When("tenant {string} tries to read that task", async function (this: ChatticusWorld, tenantId: string) {
	scenarioOf(this).otherTenantResponse = await recordResponse(
		await memberGet(this, `/orgs/${tenantId}/tasks/${lastTaskOf(this).task_id}`),
	);
});

Then("the task is stored with status {string}", async function (this: ChatticusWorld, status: string) {
	const task = lastTaskOf(this);
	const stored = await readTask(this, task.tenant_id, task.task_id);
	assert.equal(stored.status, status);
	scenarioOf(this).lastTask = stored;
});

Then("the task records bot {string} as provenance", async function (this: ChatticusWorld, botName: string) {
	const task = lastTaskOf(this);
	const stored = await readTask(this, task.tenant_id, task.task_id);
	assert.equal(stored.created_by_bot_id, botNamed(this, botName).botId);
});

Then("no computer was summoned for the task tool", async function (this: ChatticusWorld) {
	const atStop = scenarioOf(this).computerAtStop;
	assert.ok(atStop, "The scenario never stopped the computer");
	const computer = await this.messagingStore().getComputer(atStop.tenantId);
	assert.deepEqual(computer, atStop);
	const turn = await recordResponse(await memberGet(this, `/orgs/${atStop.tenantId}/turns/${currentTurnOf(this)}`));
	assert.equal(turn.status, 200, turn.text);
	assert.equal(turn.json.status, "completed");
	assert.equal(turn.json.waiting_for ?? null, null);
});

Then("completing the task is refused for missing evidence", async function (this: ChatticusWorld) {
	const body = scenarioOf(this).toolResultBody ?? "";
	assert.match(body, /cannot reach completed without evidence/);
	const task = lastTaskOf(this);
	const stored = await readTask(this, task.tenant_id, task.task_id);
	assert.equal(stored.status, "open");
	assert.equal(stored.evidence, null);
});

Then("the task evidence is {string}", function (this: ChatticusWorld, evidence: string) {
	assert.equal(lastTaskOf(this).evidence, evidence);
});

Then("the task close reason is {string}", function (this: ChatticusWorld, reason: string) {
	assert.equal(lastTaskOf(this).close_reason, reason);
});

Then("the task is not visible to the other tenant", function (this: ChatticusWorld) {
	const response = scenarioOf(this).otherTenantResponse;
	assert.ok(response, "No other tenant has tried to read the task");
	assert.equal(response.status, 404, response.text);
	assert.equal(response.json.detail, "task not found");
});

When(
	"tenant {string} posts the task tool create action for bot {string} with title {string}",
	async function (this: ChatticusWorld, tenantId: string, botName: string, title: string) {
		const scenario = scenarioOf(this);
		const response = await recordResponse(
			await memberPost(this, `/orgs/${tenantId}/users/${HOUSEHOLD_USER}/tasks`, {
				bot_id: botNamed(this, botName).botId,
				title,
			}),
		);
		scenario.httpResponse = response;
		if (response.status === 200) {
			scenario.lastTask = response.json;
			scenario.createdTaskIds.push(response.json.task_id);
		}
	},
);

Then("the HTTP task response has status {string}", function (this: ChatticusWorld, status: string) {
	const response = scenarioOf(this).httpResponse;
	assert.ok(response, "No task response");
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.status, status);
});

Then("the HTTP task response records bot {string} as provenance", function (this: ChatticusWorld, botName: string) {
	const response = scenarioOf(this).httpResponse;
	assert.ok(response, "No task response");
	assert.equal(response.json.created_by_bot_id, botNamed(this, botName).botId);
});

Then("the HTTP task tool call is denied for tenant isolation", function (this: ChatticusWorld) {
	const response = scenarioOf(this).httpResponse;
	assert.ok(response, "No task response");
	assert.ok([403, 404].includes(response.status), response.text);
});

Then(
	"tenant {string} can list tasks for user {string}:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const created = scenarioOf(this).createdTaskIds;
		const expected = cellsOf(table).map((cell) => (/^\d+$/.test(cell) ? created[Number(cell) - 1]! : cell));
		const response = await listTasksOver(this, tenantId, userId);
		assert.equal(response.status, 200, response.text);
		const listed = (response.json.tasks as TaskPayload[]).map((task) => task.task_id);
		assert.deepEqual(listed, [...expected].sort());
		for (const task of response.json.tasks as TaskPayload[]) {
			assert.equal(task.tenant_id, tenantId);
			assert.equal(task.user_id, userId);
		}
	},
);

Then("another tenant cannot list tasks for user {string}", async function (this: ChatticusWorld, userId: string) {
	const response = await listTasksOver(this, "other-household", userId);
	assert.equal(response.status, 200, response.text);
	assert.deepEqual(response.json.tasks, []);
});

Then("tenant {string} can read the HTTP task by identifier", async function (this: ChatticusWorld, tenantId: string) {
	const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/tasks/${lastTaskOf(this).task_id}`));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.task_id, lastTaskOf(this).task_id);
	assert.equal(response.json.tenant_id, tenantId);
});

Then("another tenant cannot read the HTTP task by identifier", async function (this: ChatticusWorld) {
	const response = await recordResponse(
		await memberGet(this, `/orgs/other-household/tasks/${lastTaskOf(this).task_id}`),
	);
	assert.equal(response.status, 404, response.text);
});

When("bot {string} receives {string}", async function (this: ChatticusWorld, botName: string, message: string) {
	const bot = botNamed(this, botName);
	await openChannelWithNamedBot(this, bot.tenantId, HOUSEHOLD_USER, botName);
	await post(this, { authorKind: "human", authorId: HOUSEHOLD_USER, body: message, addressedToBotId: bot.botId });
	scenarioOf(this).receivedMessage = message;
});

When(
	"bot {string} runs one task-aware computerless worker turn",
	async function (this: ChatticusWorld, botName: string) {
		const message = scenarioOf(this).receivedMessage;
		assert.ok(message, "The bot has received no message");
		const title = /titled (.+)$/.exec(message)?.[1];
		assert.ok(title, `The message names no task title: ${message}`);
		modelScenarioOf(this).scripted.toolCall(TASK_TOOL_NAME, { action: "create", title }).reply("I created the task.");
		assert.equal(await runBotTurn(this, botName), "done");
		await adoptNewTask(this, botNamed(this, botName).tenantId);
	},
);

async function webTaskContext(world: ChatticusWorld, tenantId: string, userId: string): Promise<Record<string, string>> {
	const email = await ensureTestOrganization(world, tenantId);
	const token = (await bearerFor(world, email)).Authorization.replace(/^Bearer /, "");
	return { api_base: await httpBaseUrl(world), id_token: token, tenant_id: tenantId, user_id: userId };
}

When(
	"the web UI requests the task list for tenant {string} user {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		await runMembershipUiHarness(this, "reset", {});
		await runMembershipUiHarness(this, "load-web-tasks", await webTaskContext(this, tenantId, userId));
	},
);

Then("the web UI task list shows:", function (this: ChatticusWorld, table: DataTable) {
	assert.ok(this.membershipUiHarness, "The web UI has not requested the task list");
	assert.deepEqual(this.membershipUiHarness.webTaskListTitles, cellsOf(table));
});

Then("the web UI task list is empty", function (this: ChatticusWorld) {
	assert.ok(this.membershipUiHarness, "The web UI has not requested the task list");
	assert.deepEqual(this.membershipUiHarness.webTaskListTitles, []);
});

async function webRequestsTask(world: ChatticusWorld, tenantId: string, taskId: string): Promise<void> {
	await runMembershipUiHarness(world, "reset", {});
	await runMembershipUiHarness(world, "load-web-task", {
		...(await webTaskContext(world, tenantId, HOUSEHOLD_USER)),
		task_id: taskId,
	});
}

When(
	"the web UI requests task details for the stored task as tenant {string}",
	async function (this: ChatticusWorld, tenantId: string) {
		await webRequestsTask(this, tenantId, lastTaskOf(this).task_id);
	},
);

When(
	"the web UI requests task {string} as tenant {string}",
	async function (this: ChatticusWorld, taskId: string, tenantId: string) {
		await webRequestsTask(this, tenantId, taskId);
	},
);

Then("the web UI task detail shows title {string}", function (this: ChatticusWorld, title: string) {
	assert.ok(this.membershipUiHarness, "The web UI has not requested a task");
	assert.equal(this.membershipUiHarness.webTaskError, null);
	assert.equal(this.membershipUiHarness.webTaskDetail?.title, title);
});

Then("the web UI task detail shows status {string}", function (this: ChatticusWorld, status: string) {
	assert.ok(this.membershipUiHarness, "The web UI has not requested a task");
	assert.equal(this.membershipUiHarness.webTaskDetail?.status, status);
});

Then("the web UI task detail request fails with not found", function (this: ChatticusWorld) {
	assert.ok(this.membershipUiHarness, "The web UI has not requested a task");
	assert.match(String(this.membershipUiHarness.webTaskError), /^HTTP 404/);
});
