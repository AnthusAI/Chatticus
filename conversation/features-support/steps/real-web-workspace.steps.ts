import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { runWebHarness } from "../web-harness-runner.ts";
import type { ChatticusWorld } from "../world.ts";

type Record_ = Record<string, any>;

interface WorkspaceScenario {
	bots: Record_[];
	channels: Record_[];
	messages: Record_[];
	tasks: Record_[];
	computer: Record_ | null;
	narrow: boolean;
	state: string;
	turn: Record_ | null;
	latestTurn: Record_ | null;
	activeTurn: Record_ | null;
	result: any;
	selections: Record_[];
}

function scenarioOf(world: ChatticusWorld): WorkspaceScenario {
	if (!world.webFeature.workspace) {
		world.webFeature.workspace = {
			bots: [],
			channels: [],
			messages: [],
			tasks: [],
			computer: null,
			narrow: false,
			state: "",
			turn: null,
			latestTurn: null,
			activeTurn: null,
			result: null,
			selections: [],
		} satisfies WorkspaceScenario;
	}
	return world.webFeature.workspace;
}

async function runWorkspaceHarness(world: ChatticusWorld, action: string, values: Record_ = {}): Promise<any> {
	const scenario = scenarioOf(world);
	const payload = { action, bots: scenario.bots, channels: scenario.channels, ...values };
	return runWebHarness("real-workspace-harness.ts", [JSON.stringify(payload)]);
}

function botOf(name: string, index: number): Record_ {
	return { bot_id: `bot-${index}`, tenant_id: "tenant-1", user_id: "user-1", name, memory: {} };
}

function channelOf(name: string | null, botIds: string[], channelId: string): Record_ {
	return {
		channel_id: channelId,
		tenant_id: "tenant-1",
		user_id: "user-1",
		kind: name ? "named" : "direct",
		name,
		participants: [
			{ kind: "human", actor_id: "user-1" },
			...botIds.map((botId) => ({ kind: "bot", actor_id: botId })),
		],
		next_seq: 1,
	};
}

function messageOf(seq: number, body: string): Record_ {
	return {
		message_id: `message-${seq}`,
		channel_id: "channel-direct",
		tenant_id: "tenant-1",
		seq,
		author_kind: seq % 2 ? "human" : "bot",
		author_id: seq % 2 ? "user-1" : "bot-1",
		body,
		addressed_to_bot_id: seq % 2 ? "bot-1" : null,
		created_at: "2026-09-09T20:00:00+00:00",
	};
}

function humanMessageOf(seq: number, body: string): Record_ {
	return { ...messageOf(seq, body), author_kind: "human", author_id: "user-1", addressed_to_bot_id: "bot-1" };
}

function botIdNamed(scenario: WorkspaceScenario, name: string): string {
	const bot = scenario.bots.find((candidate) => candidate.name === name);
	assert.ok(bot, `No workspace bot named ${name}`);
	return bot.bot_id;
}

function givenWorkspaceBots(world: ChatticusWorld, first: string, second: string): void {
	const scenario = scenarioOf(world);
	scenario.bots = [botOf(first, 1), botOf(second, 2)];
	scenario.channels = [];
}

function givenNamedChannel(world: ChatticusWorld, name: string): void {
	const scenario = scenarioOf(world);
	scenario.channels.push(
		channelOf(
			name,
			scenario.bots.map((bot) => bot.bot_id),
			"channel-named",
		),
	);
}

Given(
	"the real workspace has bots {string} and {string}",
	function (this: ChatticusWorld, first: string, second: string) {
		givenWorkspaceBots(this, first, second);
	},
);

Given("it has named channel {string} with those bots", function (this: ChatticusWorld, name: string) {
	givenNamedChannel(this, name);
});

Given(
	"the real workspace has named channel {string} with bots {string} and {string}",
	function (this: ChatticusWorld, name: string, first: string, second: string) {
		givenWorkspaceBots(this, first, second);
		givenNamedChannel(this, name);
	},
);

When("the real workspace builds its roster", async function (this: ChatticusWorld) {
	scenarioOf(this).result = await runWorkspaceHarness(this, "roster");
});

Then(
	"{string} and {string} are individual bot rows",
	function (this: ChatticusWorld, name: string, otherName: string) {
		const rows = scenarioOf(this).result as Record_[];
		const found = rows.map((row) => `${row.label}|${row.kind}`);
		assert.ok(found.includes(`${name}|bot`), JSON.stringify(rows));
		assert.ok(found.includes(`${otherName}|bot`), JSON.stringify(rows));
	},
);

Then(
	"{string} is a named channel row with {int} bot avatars",
	function (this: ChatticusWorld, name: string, count: number) {
		const rows = scenarioOf(this).result as Record_[];
		const row = rows.find((candidate) => candidate.label === name);
		assert.ok(row, JSON.stringify(rows));
		assert.equal(row.kind, "channel");
		assert.equal(row.botCount, count);
	},
);

Given(
	"the real workspace bot {string} has a direct channel with committed history",
	function (this: ChatticusWorld, name: string) {
		const scenario = scenarioOf(this);
		scenario.bots = [botOf(name, 1)];
		scenario.channels = [channelOf(null, ["bot-1"], "channel-direct")];
		scenario.messages = [messageOf(1, "First question"), messageOf(2, "First answer")];
	},
);

When("the member selects bot {string} twice", async function (this: ChatticusWorld, _name: string) {
	const scenario = scenarioOf(this);
	const selectOnce = () =>
		runWorkspaceHarness(this, "select", { selectedId: "bot:bot-1", messages: scenario.messages });
	scenario.selections = [await selectOnce(), await selectOnce()];
});

Then("both selections use the same direct channel", function (this: ChatticusWorld) {
	assert.deepEqual(
		scenarioOf(this).selections.map((selection) => selection.channelId),
		["channel-direct", "channel-direct"],
	);
});

Then("the committed history remains visible", function (this: ChatticusWorld) {
	const selections = scenarioOf(this).selections;
	assert.deepEqual(
		selections[selections.length - 1].messages.map((message: Record_) => message.body),
		["First question", "First answer"],
	);
});

When(
	"the member addresses {string} and sends {string}",
	async function (this: ChatticusWorld, botName: string, body: string) {
		const scenario = scenarioOf(this);
		scenario.result = await runWorkspaceHarness(this, "send", {
			selectedId: "channel:channel-named",
			addressedBotId: botIdNamed(scenario, botName),
			body,
		});
	},
);

Then("the message stays in {string}", function (this: ChatticusWorld, _channelName: string) {
	assert.equal(scenarioOf(this).result.channelId, "channel-named");
});

Then("the message is addressed to {string}", function (this: ChatticusWorld, botName: string) {
	const scenario = scenarioOf(this);
	assert.equal(scenario.result.addressedToBotId, botIdNamed(scenario, botName));
});

Given("a real workspace channel has committed messages and an active waiting turn", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.bots = [botOf("Researcher", 1)];
	scenario.channels = [channelOf(null, ["bot-1"], "channel-direct")];
	scenario.messages = [messageOf(2, "Answer"), messageOf(1, "Question")];
	scenario.turn = { status: "active", waiting_for: "computer" };
});

When("the real workspace reloads that conversation", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.result = await runWorkspaceHarness(this, "reload", { messages: scenario.messages, turn: scenario.turn });
});

Then("the committed messages are visible in sequence", function (this: ChatticusWorld) {
	assert.deepEqual(
		scenarioOf(this).result.messages.map((message: Record_) => message.seq),
		[1, 2],
	);
});

Then("the active turn is shown as waiting", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).result.turnState, "waiting");
});

Given("a real workspace turn is {string}", function (this: ChatticusWorld, state: string) {
	const scenario = scenarioOf(this);
	scenario.bots = [];
	scenario.channels = [];
	scenario.state = state;
});

When("the real workspace presents the turn", async function (this: ChatticusWorld) {
	scenarioOf(this).result = await runWorkspaceHarness(this, "turn-presentation", { state: scenarioOf(this).state });
});

Given("the real workspace roster is {string}", function (this: ChatticusWorld, state: string) {
	const scenario = scenarioOf(this);
	scenario.bots = [];
	scenario.channels = [];
	scenario.state = state;
});

When("the real workspace presents the roster", async function (this: ChatticusWorld) {
	scenarioOf(this).result = await runWorkspaceHarness(this, "roster-presentation", {
		state: scenarioOf(this).state,
	});
});

Then("its visible state is {string}", function (this: ChatticusWorld, label: string) {
	assert.equal(scenarioOf(this).result, label);
});

Given("the real workspace selected bot {string} created one task", function (this: ChatticusWorld, name: string) {
	const scenario = scenarioOf(this);
	scenario.bots = [botOf(name, 1), botOf("Writer", 2)];
	scenario.channels = [channelOf(null, ["bot-1"], "channel-direct")];
	const taskOf = (id: string, title: string, evidence: string | null, creator: string) => ({
		task_id: id,
		tenant_id: "tenant-1",
		user_id: "user-1",
		title,
		status: "open",
		evidence,
		close_reason: null,
		created_by_bot_id: creator,
		updated_by_bot_id: null,
	});
	scenario.tasks = [
		taskOf("task-1", "Review findings", "Source list", "bot-1"),
		taskOf("task-2", "Draft copy", null, "bot-2"),
	];
});

Given("the organization computer is stopped with policy {string}", function (this: ChatticusWorld, policy: string) {
	scenarioOf(this).computer = { stopped: true, policy };
});

When("the member opens the real workspace inspector", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.result = await runWorkspaceHarness(this, "inspector", {
		selectedId: "bot:bot-1",
		tasks: scenario.tasks,
		computer: scenario.computer,
	});
});

Then("the inspector shows the stopped computer and policy {string}", function (this: ChatticusWorld, policy: string) {
	const scenario = scenarioOf(this);
	assert.deepEqual(scenario.computer, { stopped: true, policy });
});

Then("the inspector shows the task created by {string}", function (this: ChatticusWorld, _name: string) {
	assert.deepEqual(
		scenarioOf(this).result.tasks.map((task: Record_) => task.task_id),
		["task-1"],
	);
});

Then("the inspector offers no unsupported computer control", function (this: ChatticusWorld) {
	assert.deepEqual(scenarioOf(this).result.computerControls, []);
});

Given("the real workspace uses a narrow viewport", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.narrow = true;
	scenario.bots = [];
	scenario.channels = [];
});

When("the member opens the roster and inspector using the keyboard", async function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).narrow, true);
	scenarioOf(this).result = await runWorkspaceHarness(this, "accessibility");
});

Then("both regions open as named sheets", function (this: ChatticusWorld) {
	assert.deepEqual(scenarioOf(this).result.sheets, ["Bots and channels", "Conversation inspector"]);
});

Then("every icon-only control has an accessible name", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).result.iconControlsNamed, true);
});

Then("keyboard focus remains visible", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).result.focusRing, true);
});

Given(
	"a real workspace conversation whose latest turn failed after the member said {string} with reason {string}",
	function (this: ChatticusWorld, body: string, reason: string) {
		const scenario = scenarioOf(this);
		scenario.bots = [botOf("Researcher", 1)];
		scenario.channels = [channelOf(null, ["bot-1"], "channel-direct")];
		scenario.messages = [humanMessageOf(1, body)];
		scenario.latestTurn = {
			turn_id: "turn-1",
			tenant_id: "tenant-1",
			channel_id: "channel-direct",
			bot_id: "bot-1",
			status: "failed",
			waiting_for: null,
			terminal_reason: reason,
			prompt_message_seq: 1,
		};
		scenario.activeTurn = null;
	},
);

Given("the member has since said {string}", function (this: ChatticusWorld, body: string) {
	const scenario = scenarioOf(this);
	scenario.messages.push(humanMessageOf(scenario.messages.length + 1, body));
});

Given("a real workspace turn has shown no progress for {int} seconds", function (this: ChatticusWorld, seconds: number) {
	const scenario = scenarioOf(this);
	scenario.bots = [botOf("Researcher", 1)];
	scenario.channels = [channelOf(null, ["bot-1"], "channel-direct")];
	scenario.messages = [humanMessageOf(1, "hello")];
	scenario.latestTurn = null;
	scenario.activeTurn = {
		turn_id: "turn-1",
		tenant_id: "tenant-1",
		channel_id: "channel-direct",
		bot_id: "bot-1",
		status: "active",
		waiting_for: null,
		silentSeconds: seconds,
	};
});

When("the real workspace shows that conversation", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.result = await runWorkspaceHarness(this, "thread", {
		messages: scenario.messages,
		latestTurn: scenario.latestTurn,
		activeTurn: scenario.activeTurn,
	});
});

Then(
	"the conversation ends with a failed reply from {string} saying {string}",
	function (this: ChatticusWorld, name: string, reason: string) {
		const items = scenarioOf(this).result as Record_[];
		const last = items[items.length - 1];
		assert.equal(last.role, "assistant", JSON.stringify(last));
		assert.equal(last.failed, true, JSON.stringify(last));
		assert.equal(last.authorBotName, name, JSON.stringify(last));
		assert.equal(last.text, reason, JSON.stringify(last));
	},
);

Then("the failed reply offers to send {string} again", function (this: ChatticusWorld, body: string) {
	const items = scenarioOf(this).result as Record_[];
	assert.equal(items[items.length - 1].retryBody, body);
});

Then("the conversation shows no failed reply", function (this: ChatticusWorld) {
	const items = scenarioOf(this).result as Record_[];
	assert.ok(!items.some((item) => item.failed), JSON.stringify(items));
});

Then("the working reply says {string}", function (this: ChatticusWorld, text: string) {
	const items = scenarioOf(this).result as Record_[];
	const last = items[items.length - 1];
	assert.equal(last.role, "assistant", JSON.stringify(last));
	assert.equal(last.text, text, JSON.stringify(last));
});
