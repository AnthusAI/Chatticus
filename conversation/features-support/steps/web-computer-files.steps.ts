import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { FilePanelProcess, type PanelState } from "../web-file-panel-process.ts";
import type { ChatticusWorld } from "../world.ts";

type PanelScenario = {
	process: FilePanelProcess;
	email: string;
	lastDraft: string | null;
	lastEditedPath: string | null;
	rowPaths: Map<string, string>;
};

const scenarios = new WeakMap<ChatticusWorld, PanelScenario>();

const SECOND = 1000;

function scenarioOf(world: ChatticusWorld): PanelScenario {
	const found = scenarios.get(world);
	assert.ok(found, "No file panel scenario is running.");
	return found;
}

function workspacePath(name: string): string {
	return name.startsWith("/") ? name : `/workspace/${name}`;
}

async function startPanel(
	world: ChatticusWorld,
	email: string,
	mode: "running" | "off" | "starting",
	role: "owner" | "member",
): Promise<void> {
	scenarios.get(world)?.process.close();
	const process = new FilePanelProcess();
	scenarios.set(world, { process, email, lastDraft: null, lastEditedPath: null, rowPaths: new Map() });
	await process.send({ op: "init", mode, role, email });
}

After(function (this: ChatticusWorld) {
	scenarios.get(this)?.process.close();
	scenarios.delete(this);
});

async function panelText(world: ChatticusWorld): Promise<PanelState> {
	return scenarioOf(world).process.state();
}

function assertShows(state: PanelState, text: string): void {
	assert.ok(state.text.includes(text), `The panel does not show "${text}". It shows: ${state.text}`);
}

Given(
	"the enabled workspace web SPA with a running computer for {string} in {string}",
	async function (this: ChatticusWorld, email: string, _organization: string) {
		await startPanel(this, email, "running", "owner");
	},
);

Given(
	"the enabled workspace web SPA with the computer off for {string} in {string}",
	async function (this: ChatticusWorld, email: string, _organization: string) {
		await startPanel(this, email, "off", "owner");
	},
);

Given(
	"the enabled workspace web SPA with the computer starting for {string} in {string}",
	async function (this: ChatticusWorld, email: string, _organization: string) {
		await startPanel(this, email, "starting", "owner");
	},
);

Given(
	"the enabled workspace web SPA with the computer off for {string} who is a member in {string}",
	async function (this: ChatticusWorld, email: string, _organization: string) {
		await startPanel(this, email, "off", "member");
	},
);

Given(
	"the enabled workspace web SPA with the computer off for {string} who is the organization owner in {string}",
	async function (this: ChatticusWorld, email: string, _organization: string) {
		await startPanel(this, email, "off", "owner");
	},
);

Given("the next live read times out", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.fake("nextLiveReadTimesOut", true);
});

Given(
	"the live computer holds workspace file {string} containing {string}",
	async function (this: ChatticusWorld, name: string, content: string) {
		await scenarioOf(this).process.fake("seed", "live", workspacePath(name), content);
	},
);

Given(
	"the live computer holds a file {string} of {int} bytes",
	async function (this: ChatticusWorld, path: string, bytes: number) {
		await scenarioOf(this).process.fake("seed", "live", path, "x".repeat(bytes));
	},
);

Given(
	"the saved copy holds workspace file {string} containing {string}",
	async function (this: ChatticusWorld, name: string, content: string) {
		await scenarioOf(this).process.fake("seed", "saved", workspacePath(name), content);
	},
);

Given(
	"the saved copy holds a folder {string} with {int} files",
	async function (this: ChatticusWorld, name: string, count: number) {
		await scenarioOf(this).process.fake("seedFolder", "saved", workspacePath(name), count);
	},
);

Given(
	"a pending edit of {string} made while the computer was off",
	async function (this: ChatticusWorld, path: string) {
		const { process } = scenarioOf(this);
		await process.fake("seed", "saved", path, "the saved text");
		await process.fake("seedPendingEdit", path, "the text edited while the computer was off");
	},
);

Given(
	"a pending edit of {string} that conflicts with a newer saved version",
	async function (this: ChatticusWorld, path: string) {
		await scenarioOf(this).process.fake("seedPendingConflict", path, "my edit made while the computer was off", "a newer saved version");
	},
);

Given(
	"pending changes: a delete of {string} and a new folder {string}",
	async function (this: ChatticusWorld, deletedPath: string, folderPath: string) {
		const { process } = scenarioOf(this);
		await process.fake("seed", "saved", deletedPath, "to be deleted");
		await process.fake("seedPendingDelete", deletedPath);
		await process.fake("seedPendingMkdir", folderPath);
	},
);

Given("the next save is answered {string} with a retry time of {int} seconds", async function (this: ChatticusWorld, code: string, seconds: number) {
	await scenarioOf(this).process.fake("scriptNextSave", { status: 503, code, retryAfterMs: seconds * SECOND });
});

Given(
	"the member is editing {string} and has changed the text",
	async function (this: ChatticusWorld, path: string) {
		const scenario = scenarioOf(this);
		await scenario.process.fake("seed", "live", path, "the text as it was loaded");
		await scenario.process.call("openFile", path);
		await scenario.process.call("beginEdit");
		scenario.lastDraft = "the text after the member changed it";
		await scenario.process.call("setDraft", scenario.lastDraft);
	},
);

Given(
	"the member is editing {string} containing {string} and has typed {string}",
	async function (this: ChatticusWorld, path: string, content: string, typed: string) {
		const scenario = scenarioOf(this);
		await scenario.process.fake("seed", "live", path, content);
		await scenario.process.call("openFile", path);
		await scenario.process.call("beginEdit");
		scenario.lastDraft = typed;
		scenario.lastEditedPath = path;
		await scenario.process.call("setDraft", typed);
	},
);

Given("the member is editing {string}", async function (this: ChatticusWorld, path: string) {
	const scenario = scenarioOf(this);
	await scenario.process.fake("seed", "live", path, "the first version of the plan");
	await scenario.process.call("openFile", path);
	await scenario.process.call("beginEdit");
	scenario.lastEditedPath = path;
	const state = await scenario.process.state();
	assert.ok(state.snapshot.edit, `The editor did not open. The panel shows: ${state.text}`);
});

Given("the bot changed that file to {string} on the computer", async function (this: ChatticusWorld, content: string) {
	const scenario = scenarioOf(this);
	assert.ok(scenario.lastEditedPath, "No file is being edited.");
	await scenario.process.fake("externalWrite", scenario.lastEditedPath, content);
});

When("the member opens the Files tab", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.send({ op: "open-tab" });
});

When("the computer is off", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.fake("setMode", "off");
});

When("the member refreshes the files", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("refresh");
});

When("the member opens {string}", async function (this: ChatticusWorld, path: string) {
	await scenarioOf(this).process.call("openFile", path);
});

When("the member opens {string} and chooses Edit", async function (this: ChatticusWorld, path: string) {
	const scenario = scenarioOf(this);
	await scenario.process.call("openFile", path);
	await scenario.process.call("beginEdit");
	scenario.lastEditedPath = path;
	const state = await scenario.process.state();
	assert.ok(state.snapshot.edit, `The editor did not open. The panel shows: ${state.text}`);
});

When("the member replaces the text with {string} and chooses Save", async function (this: ChatticusWorld, text: string) {
	const scenario = scenarioOf(this);
	scenario.lastDraft = text;
	await scenario.process.call("setDraft", text);
	await scenario.process.call("save");
});

When("the member chooses Save", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("save");
});

When("the member saves a changed file", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await scenario.process.fake("seed", "saved", "/workspace/notes.md", "the text before");
	await scenario.process.call("openFile", "/workspace/notes.md");
	await scenario.process.call("beginEdit");
	scenario.lastDraft = "the text after the change";
	await scenario.process.call("setDraft", scenario.lastDraft);
	await scenario.process.call("save");
});

When("the member chooses Back to folder", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("backToFolder");
});

When("the member chooses Overwrite with mine", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("overwriteWithMine");
});

When("the member chooses Use theirs", async function (this: ChatticusWorld) {
	const { process } = scenarioOf(this);
	await process.call("useTheirs");
	const asked = await process.state();
	assert.equal(asked.snapshot.confirm?.text, "Discard your changes?", asked.text);
	await process.send({ op: "answer", confirmed: true });
});

When("a tool call of the running turn writes {string}", async function (this: ChatticusWorld, path: string) {
	await scenarioOf(this).process.send({ op: "tool-card", tool: "write_workspace", path });
});

When("the file changes on the computer and {int} seconds go by", async function (this: ChatticusWorld, seconds: number) {
	const scenario = scenarioOf(this);
	assert.ok(scenario.lastEditedPath, "No file is being edited.");
	await scenario.process.fake("externalWrite", scenario.lastEditedPath, "changed by a shell command, no tool card");
	await scenario.process.send({ op: "advance", ms: seconds * SECOND });
});

When("the clock advances {int} seconds", async function (this: ChatticusWorld, seconds: number) {
	await scenarioOf(this).process.send({ op: "advance", ms: seconds * SECOND });
});

When("the member chooses Reveal and confirms that it is recorded", async function (this: ChatticusWorld) {
	const { process } = scenarioOf(this);
	await process.call("requestReveal");
	const asked = await process.state();
	assert.equal(
		asked.snapshot.confirm?.text,
		"Showing this file is recorded in the audit log, with your name and the time.",
		asked.text,
	);
	await process.send({ op: "answer", confirmed: true });
});

When("the member chooses Hide", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("hide");
});

When("the member switches to another tab", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("setActive", false);
});

When("the member chooses Delete on {string} and confirms", async function (this: ChatticusWorld, path: string) {
	const { process } = scenarioOf(this);
	await process.call("requestDelete", path, false);
	await process.send({ op: "answer", confirmed: true });
});

When("the member chooses Delete on the folder {string}", async function (this: ChatticusWorld, path: string) {
	await scenarioOf(this).process.call("requestDelete", path, true);
});

When("the member chooses Rename on {string} and types {string}", async function (this: ChatticusWorld, path: string, name: string) {
	await scenarioOf(this).process.call("renameEntry", path, name);
});

When("the member chooses New folder and types {string}", async function (this: ChatticusWorld, name: string) {
	await scenarioOf(this).process.call("makeFolder", name);
});

When("the member opens Pending changes", async function (this: ChatticusWorld) {
	await scenarioOf(this).process.call("setPendingOpen", true);
});

When("the member discards {string}", async function (this: ChatticusWorld, description: string) {
	const { process } = scenarioOf(this);
	const state = await process.state();
	const index = state.snapshot.pendingDescriptions.indexOf(description);
	assert.ok(index >= 0, `No pending change reads "${description}". The list: ${state.snapshot.pendingDescriptions.join(", ")}`);
	await process.call("requestDiscardPending", state.snapshot.pendingPaths[index]);
	await process.send({ op: "answer", confirmed: true });
});

Then("the panel shows the source {string}", async function (this: ChatticusWorld, text: string) {
	const state = await panelText(this);
	assert.equal(state.snapshot.sourceText, text);
	assertShows(state, text);
});

Then("the panel shows {string}", async function (this: ChatticusWorld, text: string) {
	assertShows(await panelText(this), text);
});

Then("the panel does not contain {string}", async function (this: ChatticusWorld, text: string) {
	const state = await panelText(this);
	assert.ok(!state.html.includes(text), `The panel contains "${text}".`);
});

Then("the panel asks again after {int} seconds", async function (this: ChatticusWorld, seconds: number) {
	const { process } = scenarioOf(this);
	const before = await process.state();
	assert.ok(before.timersDueIn.includes(seconds * SECOND), `No timer is due in ${seconds} s. Timers: ${before.timersDueIn.join(", ")}`);
});

Then("the editor is not offered", async function (this: ChatticusWorld) {
	const state = await panelText(this);
	assert.ok(!state.html.includes('aria-label="Edit '), "The panel offers an Edit button.");
	assert.ok(!state.html.includes(">New file<"), "The panel offers New file.");
	assert.equal(state.snapshot.edit, null);
});

Then("the panel says the file is too large to edit here", async function (this: ChatticusWorld) {
	assertShows(await panelText(this), "This file is too large to edit here");
});

Then("the live computer now holds workspace file {string} containing {string}", async function (this: ChatticusWorld, name: string, content: string) {
	const state = await scenarioOf(this).process.fakeState();
	assert.equal(state.live[workspacePath(name)], content);
});

Then("the panel asks whether to discard the changes", async function (this: ChatticusWorld) {
	const state = await panelText(this);
	assert.equal(state.snapshot.confirm?.id, "discard-draft");
	assertShows(state, "Discard your changes?");
	assertShows(state, "Keep editing");
});

Then("the panel shows the other version {string} next to the member's text", async function (this: ChatticusWorld, theirs: string) {
	const scenario = scenarioOf(this);
	const state = await scenario.process.state();
	assert.equal(state.snapshot.conflict?.theirsText, theirs, state.text);
	assert.equal(state.snapshot.conflict?.mineText, scenario.lastDraft);
	assertShows(state, theirs);
	assertShows(state, scenario.lastDraft ?? "");
});

Then("the member's text is still in the editor", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const state = await scenario.process.state();
	assert.ok(state.snapshot.edit, `No editor is open. The panel shows: ${state.text}`);
	assert.equal(state.snapshot.edit.draft, scenario.lastDraft);
	assert.ok(state.html.includes("<textarea"), "The editor is not rendered.");
});

Then("the Save button is still available", async function (this: ChatticusWorld) {
	const state = await panelText(this);
	const button = /<button[^>]*data-testid="save-button"[^>]*>/.exec(state.html);
	assert.ok(button, "There is no Save button.");
	assert.ok(!/\sdisabled(=|\s|>)/.test(button[0]), "The Save button is disabled.");
});

Then("the audit log has a reveal record for the member", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const state = await scenario.process.fakeState();
	assert.ok(
		state.audit.some((record) => record.operation === "reveal" && record.user === scenario.email),
		JSON.stringify(state.audit),
	);
});

Then("the panel tells the computer it is open", async function (this: ChatticusWorld) {
	const watches = (await scenarioOf(this).process.fakeState()).requests.filter((request) => request.route === "/watch");
	assert.ok(watches.length > 0, "The panel sent no watch ping.");
	assert.deepEqual(watches.at(-1)?.body, { open: true });
});

Then("the panel tells the computer again every {int} seconds", async function (this: ChatticusWorld, seconds: number) {
	const { process } = scenarioOf(this);
	const count = async () => (await process.fakeState()).requests.filter((request) => request.route === "/watch" && (request.body as { open: boolean }).open).length;
	const start = await count();
	for (let round = 1; round <= 3; round += 1) {
		await process.send({ op: "advance", ms: seconds * SECOND });
		assert.equal(await count(), start + round, `No ping after ${round * seconds} seconds.`);
	}
});

Then("the panel tells the computer that it is closed", async function (this: ChatticusWorld) {
	const watches = (await scenarioOf(this).process.fakeState()).requests.filter((request) => request.route === "/watch");
	assert.deepEqual(watches.at(-1)?.body, { open: false });
	assert.equal(watches.at(-1)?.keepalive, true);
});

Then("the panel stops telling the computer", async function (this: ChatticusWorld) {
	const { process } = scenarioOf(this);
	const count = async () => (await process.fakeState()).requests.filter((request) => request.route === "/watch").length;
	const before = await count();
	await process.send({ op: "advance", ms: 120 * SECOND });
	assert.equal(await count(), before);
});

Then("no computer was started", async function (this: ChatticusWorld) {
	const state = await scenarioOf(this).process.fakeState();
	assert.notEqual(state.mode, "running");
	assert.deepEqual(state.otherRequests, []);
});

Then("the listing marks {string} as {string}", async function (this: ChatticusWorld, name: string, mark: string) {
	const state = await panelText(this);
	assert.equal(state.snapshot.marks[workspacePath(name)], mark, JSON.stringify(state.snapshot.marks));
	assertShows(state, mark);
});

Then("the panel shows the saved version next to the member's text", async function (this: ChatticusWorld) {
	const state = await panelText(this);
	assert.equal(state.snapshot.conflict?.origin, "overlay");
	assert.equal(state.snapshot.conflict?.theirsText, "a newer saved version");
	assert.equal(state.snapshot.conflict?.mineText, "my edit made while the computer was off");
	assertShows(state, "a newer saved version");
	assertShows(state, "my edit made while the computer was off");
});

Then("the panel shows the saved version only", async function (this: ChatticusWorld) {
	const state = await panelText(this);
	assert.equal(state.snapshot.conflict, null);
	assertShows(state, "a newer saved version");
	assert.ok(!state.html.includes("my edit made while the computer was off"));
});

Then("the panel tries to save again after {int} seconds", async function (this: ChatticusWorld, seconds: number) {
	const state = await panelText(this);
	assert.ok(state.timersDueIn.includes(seconds * SECOND), `No retry is due in ${seconds} s. Timers: ${state.timersDueIn.join(", ")}`);
});

Then("the listing no longer shows {string}", async function (this: ChatticusWorld, name: string) {
	const state = await panelText(this);
	assert.ok(!state.snapshot.listingNames.includes(name), state.snapshot.listingNames.join(", "));
});

Then("the listing shows {string} again", async function (this: ChatticusWorld, name: string) {
	const state = await panelText(this);
	assert.ok(state.snapshot.listingNames.includes(name), state.snapshot.listingNames.join(", "));
});

Then(
	"the listing shows {string} marked {string} and not {string}",
	async function (this: ChatticusWorld, name: string, mark: string, gone: string) {
		const state = await panelText(this);
		assert.equal(state.snapshot.marks[workspacePath(name)], mark, JSON.stringify(state.snapshot.marks));
		assert.ok(!state.snapshot.listingNames.includes(gone), state.snapshot.listingNames.join(", "));
		assertShows(state, mark);
	},
);

Then("the listing shows the folder {string} marked {string}", async function (this: ChatticusWorld, name: string, mark: string) {
	const state = await panelText(this);
	assert.ok(state.snapshot.listingNames.includes(name), state.snapshot.listingNames.join(", "));
	assert.equal(state.snapshot.marks[workspacePath(name)], mark, JSON.stringify(state.snapshot.marks));
});

Then("the folder {string} offers no recursive delete", async function (this: ChatticusWorld, name: string) {
	const { process } = scenarioOf(this);
	await process.call("requestDelete", workspacePath(name), true);
	const state = await process.state();
	assert.equal(state.snapshot.confirm?.id, "delete-blocked", state.text);
	assert.equal(state.snapshot.confirm?.confirmLabel, null);
	await process.send({ op: "answer", confirmed: false });
	const after = await process.fakeState();
	assert.ok(!after.requests.some((request) => request.method === "DELETE"), "A delete reached the computer.");
});

Then("the panel asks {string}", async function (this: ChatticusWorld, question: string) {
	const state = await panelText(this);
	assert.equal(state.snapshot.confirm?.text, question);
	assertShows(state, question);
});

Then("the folder is deleted only after the member confirms", async function (this: ChatticusWorld) {
	const { process } = scenarioOf(this);
	const before = await process.fakeState("/workspace", "/workspace/old");
	assert.ok(!before.requests.some((request) => request.method === "DELETE"), "The folder was deleted before the member confirmed.");
	assert.equal(before.exists, true);
	await process.send({ op: "answer", confirmed: true });
	const after = await process.fakeState("/workspace", "/workspace/old");
	const deletion = after.requests.find((request) => request.method === "DELETE");
	assert.ok(deletion, "No delete was sent after the member confirmed.");
	assert.equal(deletion.query.recursive, "true");
	assert.equal(after.exists, false);
});

Then("the panel lists {string} and {string}", async function (this: ChatticusWorld, first: string, second: string) {
	const state = await panelText(this);
	assert.deepEqual(state.snapshot.pendingDescriptions.sort(), [first, second].sort());
	assertShows(state, first);
	assertShows(state, second);
});
