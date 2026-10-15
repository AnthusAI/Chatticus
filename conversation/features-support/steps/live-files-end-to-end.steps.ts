import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { SUPERVISOR_EXIT_SIGTERM } from "../../../computer/host/src/supervisor-ports.ts";
import { SnapshotFileService } from "../../src/snapshot/files.ts";
import { hashOf, memberFilesOf, sendFileRoute, settleInFlight } from "../computer-file-live-support.ts";
import { fileRoutesOf, snapshotReadStoreOf } from "../computer-snapshot-files-support.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { COMPUTER_ID, overlayScenarioOf, storedIndexOf } from "../edit-overlay-support.ts";
import { letSecondsGoByForTheSupervisor, liveWorkspaceOf, startSupervisorOnRealDisk } from "../live-files-end-to-end-support.ts";
import { memberHeadersFor } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { changeAs, effectiveHashOf, renameInOverlay } from "./computer-file-operations.steps.ts";
import { logLinesOf, longLivedOf, runUntil } from "./owner-long-lived.steps.ts";

const TENANT = STORY_TENANT;
const FILES = `/orgs/${TENANT}/computer/files`;
const MAX_CONTENT_RANGE_BYTES = 262144;

const workspaceFile = (world: ChatticusWorld, relative: string): string => join(liveWorkspaceOf(world), relative.replace(/^\/workspace\//, ""));

/** Let the supervisor run until the member's request that waits for the owner is answered, then take the response. */
async function untilTheMemberRequestIsAnswered(world: ChatticusWorld): Promise<void> {
	const files = memberFilesOf(world);
	assert.ok(files.pending, `No file request is waiting for the supervisor; the Front Door answered it at once: ${fileRoutesOf(world).response?.text}`);
	let answered = false;
	void files.pending.then(
		() => {
			answered = true;
		},
		() => {
			answered = true;
		},
	);
	await runUntil(world, "the file request is answered", () => answered);
	await settleInFlight(world, 0);
}

Given("a supervisor with the real computer disk is running for the household computer", async function (this: ChatticusWorld) {
	await startSupervisorOnRealDisk(this);
});

Given("a new supervisor with the real computer disk is started and hydrates", async function (this: ChatticusWorld) {
	await startSupervisorOnRealDisk(this);
});

Given("the live disk holds workspace file {string} containing {string}", function (this: ChatticusWorld, relative: string, content: string) {
	const path = workspaceFile(this, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
});

Given(
	"member {string} has read the computer file {string} from the supervisor and holds its hash",
	async function (this: ChatticusWorld, userId: string, path: string) {
		const headers = await memberHeadersFor(this, TENANT, userId);
		const first = await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}`, headers });
		if (first === null) await untilTheMemberRequestIsAnswered(this);
		const answered = fileRoutesOf(this).response;
		assert.ok(answered, "The read was not answered.");
		assert.equal(answered.status, 200, answered.text);
		memberFilesOf(this).heldHashes.set(`${userId} ${path}`, answered.json.sha256);
	},
);

Given(
	"member {string} replaced {string} with {string} while the computer was off",
	async function (this: ChatticusWorld, userId: string, path: string, content: string) {
		await changeAs(this, userId, { op: "put", path, content, precondition: { type: "if_match", sha256: await effectiveHashOf(this, path) } });
	},
);

Given(
	"member {string} deleted {string} and renamed {string} to {string} while the computer was off",
	async function (this: ChatticusWorld, userId: string, deleted: string, from: string, to: string) {
		await changeAs(this, userId, { op: "delete", path: deleted, recursive: false, ownerRole: false, ifMatchSha256: await effectiveHashOf(this, deleted) });
		await renameInOverlay(this, userId, from, to);
	},
);

Given("the supervisor applied the overlay but has not published", function (this: ChatticusWorld) {
	const scenario = longLivedOf(this);
	assert.equal(logLinesOf(scenario, "overlay_applied").length, 1, `The supervisor did not apply the overlay. Log: ${scenario.logs.join(" | ")}`);
	assert.equal(logLinesOf(scenario, "snapshot_published").length, 0, "The supervisor had already published.");
});

When("the supervisor polls until the file request is answered", async function (this: ChatticusWorld) {
	await untilTheMemberRequestIsAnswered(this);
});

When("{int} seconds go by while the supervisor runs", async function (this: ChatticusWorld, seconds: number) {
	await letSecondsGoByForTheSupervisor(this, seconds);
});

When("{int} seconds go by while no supervisor runs", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When("the task is killed without a stopped report", function (this: ChatticusWorld) {
	const scenario = longLivedOf(this);
	assert.equal(scenario.exitCode, null, "The supervisor had already ended.");
	assert.deepEqual(scenario.stopReasons, [], "The supervisor had already asked to stop.");
});

When("the task is told to stop and the supervisor stops", async function (this: ChatticusWorld) {
	const scenario = longLivedOf(this);
	scenario.supervisor.requestTermination();
	await runUntil(this, "the supervisor has stopped", () => scenario.exitCode !== null);
	assert.equal(scenario.exitCode, SUPERVISOR_EXIT_SIGTERM, `Log: ${scenario.logs.join(" | ")}`);
	assert.ok(logLinesOf(scenario, "owner_stopping").some((line) => line.includes("reason=sigterm")), `The supervisor did not stop on the signal. Log: ${scenario.logs.join(" | ")}`);
});

Then("the supervisor has published the snapshot", function (this: ChatticusWorld) {
	const scenario = longLivedOf(this);
	assert.ok(logLinesOf(scenario, "snapshot_published").length > 0, `The supervisor has not published. Log: ${scenario.logs.join(" | ")}`);
});

Then("the file {string} on the live disk contains {string}", function (this: ChatticusWorld, relative: string, content: string) {
	assert.equal(readFileSync(workspaceFile(this, relative), "utf8"), content);
});

Then("the saved snapshot now holds workspace file {string} containing {string}", async function (this: ChatticusWorld, relative: string, content: string) {
	assert.ok(fileRoutesOf(this).bucket, "The scenario has no snapshot bucket.");
	const saved = await new SnapshotFileService(snapshotReadStoreOf(this)).content(TENANT, COMPUTER_ID, `/workspace/${relative}`, { offset: 0, length: MAX_CONTENT_RANGE_BYTES });
	assert.equal(saved.content, content);
	assert.equal(saved.sha256, hashOf(content));
});

Then("the overlay is empty and not sealed by a stopped owner", async function (this: ChatticusWorld) {
	const index = await storedIndexOf(this);
	assert.deepEqual(index?.entries ?? [], []);
	assert.equal(index?.sealed ?? null, null);
});

Then("the edit overlay still holds an entry for {string}", async function (this: ChatticusWorld, path: string) {
	const index = await storedIndexOf(this);
	assert.ok((index?.entries ?? []).some((entry) => entry.path === path), `The overlay holds no entry for ${path}: ${JSON.stringify(index)}`);
	assert.ok(overlayScenarioOf(this));
});

Then(
	"a member reads the computer file {string} and gets {string} from the snapshot with the overlay",
	async function (this: ChatticusWorld, path: string, content: string) {
		const headers = await memberHeadersFor(this, TENANT, "mia");
		const response = await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}`, headers });
		assert.ok(response, "The read waited for an owner that is gone.");
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.content, content);
		assert.equal(response.json.source, "snapshot", response.text);
		assert.equal(response.json.overlay, "pending", response.text);
	},
);
