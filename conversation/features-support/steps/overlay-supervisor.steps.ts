import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import { formatLogLine } from "../../src/observability/log-line.ts";
import { blobHashOf } from "../fakes/fake-overlay-blob-store.ts";
import { dispatchPollAnswer, ownerRouteRefusal } from "../fakes/fake-supervisor-plane.ts";
import {
	addDirectoryMoveEntry,
	addEmptyFolderDeleteEntry,
	addFileDeleteEntry,
	addFileMoveEntry,
	addMkdirEntry,
	addPutEntry,
	createOverlayWorldState,
	lettingSecondsPass,
	overlayWorldStateOf,
	runUntil,
	seedFile,
	seedSymlink,
	seededTreeHashOf,
	startAndHydrate,
} from "../overlay-supervisor-support.ts";
import { createSupervisorScenario, logLinesOf, supervisorScenarioOf } from "../owner-supervisor-support.ts";
import type { OwnerErrorCode } from "@chatticus/host-protocol/supervisor";
import type { ChatticusWorld } from "../world.ts";

const OUTSIDE_CONTENT = "outside secret";

const workspaceOf = (world: ChatticusWorld): string => supervisorScenarioOf(world).workspaceRoot;

const clearReportsOf = (world: ChatticusWorld) => supervisorScenarioOf(world).plane.overlayAppliedPosts.filter((post) => (post.request.cleared ?? []).length > 0);

const conflictReportsOf = (world: ChatticusWorld) => supervisorScenarioOf(world).plane.overlayAppliedPosts.flatMap((post) => post.request.conflicts ?? []);

const revisionOfEntry = (world: ChatticusWorld, path: string): number => {
	const entry = supervisorScenarioOf(world).plane.overlayEntries.find((candidate) => candidate.path === path);
	assert.ok(entry, `The overlay holds no entry for ${path}.`);
	return entry.revision;
};

Given("a supervisor over a real computer disk with an edit overlay", function (this: ChatticusWorld) {
	const scenario = createSupervisorScenario(this);
	scenario.useRealDisk = true;
	scenario.workspaceRoot = join(scenario.environment["CHATTICUS_LIVE_ROOT"]!, "workspace");
	scenario.fileHelper.useRealProcess = false;
	scenario.fileHelper.onRequest = (request) => scenario.logs.push(formatLogLine("helper_request", { operation: request.operation }));
	createOverlayWorldState(this);
});

Given("the saved snapshot holds workspace file {string} containing {string}", function (this: ChatticusWorld, path: string, content: string) {
	seedFile(this, path, content);
});

Given("the saved snapshot already holds {string} in {string}", function (this: ChatticusWorld, content: string, path: string) {
	seedFile(this, path.replace(/^\/workspace\//, ""), content);
});

Given("the saved snapshot holds these workspace files:", function (this: ChatticusWorld, table: DataTable) {
	for (const row of table.hashes()) seedFile(this, row["path"]!, row["content"]!);
});

Given("the saved snapshot holds {int} files in the folder {string}", function (this: ChatticusWorld, count: number, folder: string) {
	for (let index = 0; index < count; index += 1) seedFile(this, `${folder}/file-${index}.txt`, `content ${index}`);
});

Given("the saved snapshot holds a symbolic link {string} to a file outside the workspace", function (this: ChatticusWorld, name: string) {
	assert.ok(this.snapshotTmpdir);
	const outside = join(this.snapshotTmpdir, "outside");
	mkdirSync(outside, { recursive: true });
	const outsideFile = join(outside, "secret.txt");
	writeFileSync(outsideFile, OUTSIDE_CONTENT);
	overlayWorldStateOf(this).outsideFile = outsideFile;
	seedSymlink(this, name, outsideFile);
});

Given("the local cache already holds the published snapshot", function (this: ChatticusWorld) {
	overlayWorldStateOf(this).cacheMatched = true;
});

Given("no snapshot was ever published", function (this: ChatticusWorld) {
	assert.equal(overlayWorldStateOf(this).seeded, false);
});

Given("a turn is already parked for the computer", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	scenario.plane.parkedDispatch = dispatchPollAnswer({ turnId: "turn-parked" }, scenario.clock);
});

Given("the overlay holds {string} for {string} with base hash of {string}", async function (this: ChatticusWorld, content: string, path: string, baseText: string) {
	await addPutEntry(this, path, content, { baseHash: blobHashOf(baseText) });
});

Given("the overlay holds {string} for {string} with base hash of {string} flagged as a conflict", async function (this: ChatticusWorld, content: string, path: string, baseText: string) {
	await addPutEntry(this, path, content, { baseHash: blobHashOf(baseText), flaggedAsConflict: true });
});

Given("the overlay holds {string} for a new file {string}", async function (this: ChatticusWorld, content: string, path: string) {
	await addPutEntry(this, path, content, { baseHash: null });
});

Given(
	"the overlay holds {string} for {string} renamed from {string} with the hash of {string}",
	async function (this: ChatticusWorld, content: string, path: string, from: string, fromText: string) {
		await addPutEntry(this, path, content, { baseHash: null, from: { path: from, sha256: blobHashOf(fromText) } });
	},
);

Given("the overlay holds {string} for {string} with base hash of the link target", async function (this: ChatticusWorld, content: string, path: string) {
	await addPutEntry(this, path, content, { baseHash: blobHashOf(OUTSIDE_CONTENT) });
});

Given("the overlay holds an entry whose blob is missing", async function (this: ChatticusWorld) {
	await addPutEntry(this, "/workspace/notes.md", "second draft", { baseHash: blobHashOf("first draft"), storeBlob: false });
});

Given("the overlay holds an entry whose blob holds other bytes", async function (this: ChatticusWorld) {
	const entry = await addPutEntry(this, "/workspace/notes.md", "second draft", { baseHash: blobHashOf("first draft"), storeBlob: false });
	assert.equal(entry.op, "put");
	await supervisorScenarioOf(this).overlayBlobs.putUnder(blobHashOf("second draft"), Buffer.from("something else entirely", "utf8"));
});

Given("the overlay holds a mkdir of {string}", function (this: ChatticusWorld, path: string) {
	addMkdirEntry(this, path);
});

Given("the overlay holds a move of the folder {string} to {string} with the tree hash it was shown", function (this: ChatticusWorld, from: string, to: string) {
	addDirectoryMoveEntry(this, from, to, seededTreeHashOf(this, from));
});

Given("the overlay holds a move of {string} to {string} with the hash of {string}", function (this: ChatticusWorld, from: string, to: string, text: string) {
	addFileMoveEntry(this, from, to, blobHashOf(text));
});

Given("the overlay holds a delete of {string} with base hash of {string}", function (this: ChatticusWorld, path: string, text: string) {
	addFileDeleteEntry(this, path, blobHashOf(text));
});

Given("the overlay holds a delete of the empty folder {string}", function (this: ChatticusWorld, path: string) {
	addEmptyFolderDeleteEntry(this, path);
});

Given("the control plane does not answer the clear request", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).plane.overlayClearsFailWith = new DOMException("The operation timed out.", "TimeoutError");
});

Given("the control plane answers the first seal with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.overlaySealScript = [ownerRouteRefusal(status, code as OwnerErrorCode)];
});

Given("the control plane answers every seal with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.overlaySealFailsWith = ownerRouteRefusal(status, code as OwnerErrorCode);
});

When("the supervisor starts and hydrates", async function (this: ChatticusWorld) {
	await startAndHydrate(this);
});

When("the supervisor starts, hydrates and polls until it is served", async function (this: ChatticusWorld) {
	await startAndHydrate(this);
	const scenario = supervisorScenarioOf(this);
	await runUntil(this, () => scenario.spawner.children.length > 0, 30);
});

When("the supervisor starts, hydrates and publishes", async function (this: ChatticusWorld) {
	await startAndHydrate(this);
	const scenario = supervisorScenarioOf(this);
	await runUntil(this, () => scenario.plane.computerCalls.includes("published"), 30);
	await runUntil(this, () => scenario.plane.overlayAppliedPosts.some((post) => (post.request.cleared ?? []).length > 0), 0);
});

When("{int} seconds go by with the supervisor idle", async function (this: ChatticusWorld, seconds: number) {
	await lettingSecondsPass(this, seconds);
});

When("the supervisor is told to stop", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.supervisor);
	overlayWorldStateOf(this).clearReportsAtMark = clearReportsOf(this).length;
	scenario.supervisor.requestTermination();
	await runUntil(this, () => scenario.exitCode !== null, 60);
});

Then("the supervisor extracted the snapshot, then sealed the overlay, then applied the entries", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const logs = scenario.logs;
	const extracted = logs.findIndex((line) => line.startsWith("workspace_hydrated"));
	const sealed = logs.findIndex((line) => line.startsWith("overlay_sealed"));
	const firstHelperRequest = logs.findIndex((line) => line.startsWith("helper_request"));
	const applied = logs.findIndex((line) => line.startsWith("overlay_applied"));
	assert.ok(extracted >= 0 && sealed > extracted && firstHelperRequest > sealed && applied > firstHelperRequest, `Order of extract, seal, helper, applied: ${extracted}, ${sealed}, ${firstHelperRequest}, ${applied}. Log: ${logs.join(" | ")}`);
	assert.equal(scenario.snapshotStore.packReads, 1, "The pack was not downloaded exactly once.");
});

Then("the snapshot was not extracted again", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.snapshotStore.packReads, 0, "The pack was downloaded although the local copy matched.");
	assert.ok(logLinesOf(this, "workspace_hydrated").length > 0);
});

Then("the computer workspace file {string} contains {string}", function (this: ChatticusWorld, path: string, content: string) {
	assert.equal(readFileSync(join(workspaceOf(this), path), "utf8"), content);
});

Then("the computer workspace has no {string}", function (this: ChatticusWorld, path: string) {
	const full = join(workspaceOf(this), path);
	let present = true;
	try {
		lstatSync(full);
	} catch {
		present = false;
	}
	assert.equal(present, false, `${path} is still in the workspace.`);
});

Then("the computer workspace has {int} files in {string} and no folder {string}", function (this: ChatticusWorld, count: number, folder: string, gone: string) {
	assert.equal(readdirSync(join(workspaceOf(this), folder)).length, count);
	assert.equal(existsSync(join(workspaceOf(this), gone)), false);
});

Then("the supervisor accepted no dispatch before the apply ended", function (this: ChatticusWorld) {
	const logs = supervisorScenarioOf(this).logs;
	const applied = logs.findIndex((line) => line.startsWith("overlay_applied"));
	assert.ok(applied >= 0, `The overlay was never applied. Log: ${logs.join(" | ")}`);
	const accepted = logs.findIndex((line) => line.startsWith("owner_dispatch_received") || line.startsWith("owner_serving_turn"));
	assert.ok(accepted === -1 || accepted > applied, `A dispatch was accepted at line ${accepted}, before the apply ended at ${applied}.`);
	const refusedWhileHydrating = logs.findIndex((line) => line.startsWith("owner_dispatch_ignored") && line.includes("reason=busy"));
	assert.ok(refusedWhileHydrating >= 0 && refusedWhileHydrating < applied, "The parked turn was never offered while the supervisor applied the overlay.");
});

Then("the supervisor reported {string} until the apply ended", function (this: ChatticusWorld, state: string) {
	const scenario = supervisorScenarioOf(this);
	const polls = scenario.plane.polls.map((recorded) => recorded.request.state);
	assert.ok(polls.includes(state as never), `No poll reported ${state}: ${polls.join(",")}.`);
	assert.deepEqual(
		polls.filter((reported) => reported !== "booting" && reported !== state),
		[],
		`A poll before the apply ended reported another state: ${polls.join(",")}.`,
	);
	assert.equal(scenario.supervisor?.state, "idle");
});

Then("the turn ran", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).spawner.children.length, 1);
});

Then("no turn was served", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).spawner.children.length, 0);
	assert.equal(logLinesOf(this, "owner_serving_turn").length, 0);
});

Then("the overlay still holds the entry for {string}", function (this: ChatticusWorld, path: string) {
	assert.ok(supervisorScenarioOf(this).plane.overlayEntries.some((entry) => entry.path === path));
	assert.equal(clearReportsOf(this).length, 0);
});

Then("the supervisor did not publish while the turn ran", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).plane.publishOrders.length, 0);
});

Then("the supervisor did not publish", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).plane.publishOrders.length, 0);
});

Then("the supervisor published the snapshot", function (this: ChatticusWorld) {
	assert.ok(supervisorScenarioOf(this).plane.publishOrders.length >= 1, `No publish. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then("the supervisor asked to clear nothing yet", function (this: ChatticusWorld) {
	assert.equal(clearReportsOf(this).length, 0);
});

Then("the supervisor asked to clear nothing", function (this: ChatticusWorld) {
	assert.equal(clearReportsOf(this).length, 0);
});

Then("after the publish was recorded the supervisor asked to clear exactly {string} at the revision it applied", function (this: ChatticusWorld, path: string) {
	const plane = supervisorScenarioOf(this).plane;
	const reports = clearReportsOf(this);
	assert.ok(reports.length >= 1, `The supervisor never asked to clear. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
	const first = reports[0]!;
	assert.deepEqual(first.request.cleared, [{ path, revision: 1 }]);
	assert.ok(plane.publishOrders.length >= 1 && first.order > plane.publishOrders[0]!, "The clear was asked for before the publish was recorded.");
});

Then("the supervisor asked to clear again", function (this: ChatticusWorld) {
	assert.ok(clearReportsOf(this).length >= 2, `The clear was asked for ${clearReportsOf(this).length} time(s).`);
});

Then("the supervisor asked to clear before it reported the computer stopped", function (this: ChatticusWorld) {
	const plane = supervisorScenarioOf(this).plane;
	const reports = clearReportsOf(this);
	assert.ok(reports.length > overlayWorldStateOf(this).clearReportsAtMark, "The supervisor did not ask to clear after it was told to stop.");
	assert.equal(plane.stoppedReports.length, 1, "The stopped report was not made once.");
	assert.ok(reports[reports.length - 1]!.order < plane.stoppedReports[0]!.order, "The last clear request came after the stopped report.");
});

Then("the supervisor asked to clear {string} at once", function (this: ChatticusWorld, path: string) {
	const reports = clearReportsOf(this);
	assert.ok(reports.some((report) => (report.request.cleared ?? []).some((cleared) => cleared.path === path)), `No clear for ${path}. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
	assert.equal(supervisorScenarioOf(this).plane.publishOrders.length, 0);
});

Then("the supervisor reported a conflict for {string}", function (this: ChatticusWorld, path: string) {
	assert.ok(conflictReportsOf(this).some((report) => report.path === path), `No conflict for ${path}. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then("the supervisor reported a conflict for {string} with the disk hash of {string}", function (this: ChatticusWorld, path: string, text: string) {
	const report = conflictReportsOf(this).find((candidate) => candidate.path === path);
	assert.ok(report, `No conflict for ${path}.`);
	assert.equal(report.disk_sha256, blobHashOf(text));
	assert.equal(report.revision, revisionOfEntry(this, path));
});

Then("the supervisor reported a conflict for {string} with reason {string}", function (this: ChatticusWorld, path: string, reason: string) {
	const report = conflictReportsOf(this).find((candidate) => candidate.path === path);
	assert.ok(report, `No conflict for ${path}.`);
	assert.equal(report.reason, reason);
});

Then("the supervisor reported no conflict", function (this: ChatticusWorld) {
	assert.equal(conflictReportsOf(this).length, 0);
});

Then("the workspace was not written", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).fileHelper.requests.filter((request) => request.operation === "write").length, 0);
});

Then("the outside file is unchanged", function (this: ChatticusWorld) {
	const outside = overlayWorldStateOf(this).outsideFile;
	assert.ok(outside);
	assert.equal(readFileSync(outside, "utf8"), OUTSIDE_CONTENT);
});

Then("the helper was asked for these operations in order: {}", function (this: ChatticusWorld, operations: string) {
	const asked = supervisorScenarioOf(this).fileHelper.requests.map((request) => request.operation);
	assert.deepEqual(asked, operations.split(", "));
});

Then("the helper was asked for exactly one rename", function (this: ChatticusWorld) {
	const asked = supervisorScenarioOf(this).fileHelper.requests.map((request) => request.operation);
	assert.deepEqual(asked, ["rename"]);
});

Then("the supervisor sealed the overlay {int} times", function (this: ChatticusWorld, count: number) {
	assert.equal(supervisorScenarioOf(this).plane.overlaySeals.length, count);
});

