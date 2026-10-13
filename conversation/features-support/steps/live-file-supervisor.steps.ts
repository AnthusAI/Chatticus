import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import { symlinkHashOf } from "@chatticus/host-protocol/live-file-rules";
import { ownerRouteRefusal } from "../fakes/fake-supervisor-plane.ts";
import { computerOwnerScenarioOf } from "../computer-owner.ts";
import {
	advanceUntil,
	awaitOutcome,
	ensureIdleSupervisor,
	lastOutcomeOf,
	liveFileScenarioOf,
	offerFileRequest,
	postedOutcomeOf,
	sha256OfText,
	treeHashOfDirectory,
} from "../live-file-supervisor-support.ts";
import { exitChild, logLinesOf, serveTurn, supervisorScenarioOf } from "../owner-supervisor-support.ts";
import type { ChatticusWorld } from "../world.ts";

const workspaceOf = (world: ChatticusWorld): string => computerOwnerScenarioOf(world).workspace;

const pathInWorkspace = (world: ChatticusWorld, name: string): string => join(workspaceOf(world), name);

const WRONG_HASH = "f".repeat(64);

const sha256OfBytesText = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

const useFakeTimeHelper = (world: ChatticusWorld, seconds: number): void => {
	const launcher = supervisorScenarioOf(world).fileHelper;
	launcher.useRealProcess = false;
	launcher.delayMilliseconds = seconds * 1000;
	launcher.afterRun = (request, response) => {
		if (response.ok && ["write", "mkdir", "unlink", "rmtree", "rename"].includes(request.operation)) supervisorScenarioOf(world).disk.workspaceChanged = true;
	};
};

Given("the workspace holds a file {string} of {int} bytes, a directory {string} and a symbolic link {string} to {string}", function (this: ChatticusWorld, name: string, size: number, directory: string, link: string, target: string) {
	writeFileSync(pathInWorkspace(this, name), "x".repeat(size));
	mkdirSync(pathInWorkspace(this, directory), { recursive: true });
	symlinkSync(target, pathInWorkspace(this, link));
});

Given("the workspace has a symbolic link {string} to {string}", function (this: ChatticusWorld, link: string, target: string) {
	mkdirSync(dirname(pathInWorkspace(this, link)), { recursive: true });
	symlinkSync(target, pathInWorkspace(this, link));
});

Given("the workspace holds a named pipe {string}", function (this: ChatticusWorld, name: string) {
	execFileSync("mkfifo", [pathInWorkspace(this, name)]);
});

Given("the file helper never answers", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).fileHelper.hangs = true;
});

Given("the file helper takes {int} seconds for each operation", function (this: ChatticusWorld, seconds: number) {
	useFakeTimeHelper(this, seconds);
});

Given("the file helper takes no time", function (this: ChatticusWorld) {
	useFakeTimeHelper(this, 0);
});

Given("two file operations are running", async function (this: ChatticusWorld) {
	await offerFileRequest(this, "/workspace/slow-one.txt", { kind: "read" });
	await offerFileRequest(this, "/workspace/slow-two.txt", { kind: "read" });
});

Given("the supervisor is serving a turn", async function (this: ChatticusWorld) {
	await ensureIdleSupervisor(this);
	await serveTurn(this, "turn-1");
});

Given("a file operation is running", async function (this: ChatticusWorld) {
	writeFileSync(pathInWorkspace(this, "running.txt"), "running");
	await offerFileRequest(this, "/workspace/running.txt", { kind: "read" });
});

Given("a write operation is running", async function (this: ChatticusWorld) {
	await offerFileRequest(this, "/workspace/stop-edit.txt", { kind: "write", content: "edited while stopping", precondition: { type: "if_none_match" } });
});

Given("another file operation is running", async function (this: ChatticusWorld) {
	await offerFileRequest(this, "/workspace/slow-two.txt", { kind: "read" });
});

Given("a third file request is waiting", async function (this: ChatticusWorld) {
	await offerFileRequest(this, "/workspace/waiting.txt", { kind: "read" });
});

Given("the supervisor is idle with its idle clock at {int} minutes", async function (this: ChatticusWorld, minutes: number) {
	await ensureIdleSupervisor(this);
	await supervisorScenarioOf(this).clock.advance(minutes * 60_000);
	assert.equal(supervisorScenarioOf(this).supervisor?.state, "idle");
});

Given("the control plane will answer the next file result with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.fileResultScript.push(ownerRouteRefusal(status, code as Parameters<typeof ownerRouteRefusal>[1]));
});

When("the supervisor is given a list request for {string}", async function (this: ChatticusWorld, path: string) {
	await offerFileRequest(this, path, { kind: "list" });
});

When("the supervisor is given a read request for {string}", async function (this: ChatticusWorld, path: string) {
	await offerFileRequest(this, path, { kind: "read" });
});

When("the supervisor answers a read of {string}", async function (this: ChatticusWorld, path: string) {
	const id = await offerFileRequest(this, path, { kind: "read" });
	await awaitOutcome(this, id);
});

When("the supervisor is given a write request for {string} with {string} and the hash of {string}", async function (this: ChatticusWorld, path: string, content: string, text: string) {
	await offerFileRequest(this, path, { kind: "write", content, precondition: { type: "if_match", sha256: sha256OfText(text) } });
});

When("the supervisor is given a create request for {string} with {string}", async function (this: ChatticusWorld, path: string, content: string) {
	await offerFileRequest(this, path, { kind: "write", content, precondition: { type: "if_none_match" } });
});

When("the supervisor is given a create request for {string} with {string} that expires in {int} seconds", async function (this: ChatticusWorld, path: string, content: string, seconds: number) {
	await offerFileRequest(this, path, { kind: "write", content, precondition: { type: "if_none_match" } }, seconds * 1000);
});

When("a write request is answered ok", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const logIndexBefore = scenario.logs.length;
	const id = await offerFileRequest(this, "/workspace/edited.txt", { kind: "write", content: "edited", precondition: { type: "if_none_match" } });
	const outcome = await awaitOutcome(this, id);
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	liveFileScenarioOf(this).marks.set("log-index-before-write", logIndexBefore);
	liveFileScenarioOf(this).marks.set("write-answered-at", scenario.clock.nowMilliseconds());
});

When("the supervisor is given a delete request for {string} with the symlink hash", async function (this: ChatticusWorld, path: string) {
	const name = path.replace("/workspace/", "");
	const hash = symlinkHashOf(readlinkSync(pathInWorkspace(this, name)), sha256OfBytesText);
	await offerFileRequest(this, path, { kind: "delete", recursive: false, precondition: { type: "if_match", sha256: hash } });
});

When("the supervisor is given a recursive delete request for {string} with another tree hash", async function (this: ChatticusWorld, path: string) {
	await offerFileRequest(this, path, { kind: "delete", recursive: true, precondition: { type: "if_match_tree", tree_sha256: WRONG_HASH } });
});

When("the supervisor is given a recursive delete request for {string} with the current tree hash", async function (this: ChatticusWorld, path: string) {
	const name = path.replace("/workspace/", "");
	await offerFileRequest(this, path, { kind: "delete", recursive: true, precondition: { type: "if_match_tree", tree_sha256: treeHashOfDirectory(pathInWorkspace(this, name)) } });
});

When("the supervisor is given a move request from {string} to {string} with the hash of {string}", async function (this: ChatticusWorld, from: string, to: string, text: string) {
	await offerFileRequest(this, from, { kind: "move", to, precondition: { type: "if_match", sha256: sha256OfText(text) } });
});

When("the turn's child exits", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const original = scenario.table.list.bind(scenario.table);
	scenario.table.list = async () => {
		liveFileScenarioOf(this).marks.set("sweep-listed-at", scenario.clock.nowMilliseconds());
		return original();
	};
	await exitChild(this, 0);
});

When("the supervisor begins to stop", async function (this: ChatticusWorld) {
	supervisorScenarioOf(this).supervisor?.requestTermination();
	await supervisorScenarioOf(this).clock.settle();
});

Then("the result is ok", async function (this: ChatticusWorld) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
});

Then("the result is the error {string}", async function (this: ChatticusWorld, code: string) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "error", JSON.stringify(outcome));
	if (outcome.status === "error") assert.equal(outcome.code, code, JSON.stringify(outcome));
});

Then("the result is the error {string} within {int} seconds", async function (this: ChatticusWorld, code: string, seconds: number) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "error", JSON.stringify(outcome));
	if (outcome.status === "error") assert.equal(outcome.code, code, JSON.stringify(outcome));
	const id = liveFileScenarioOf(this).lastOperationId!;
	const took = liveFileScenarioOf(this).observedAfterRealMilliseconds.get(id) ?? Number.POSITIVE_INFINITY;
	assert.ok(took < seconds * 1000, `The answer took ${took} ms.`);
});

Then("the result is the error {string} with the current tree hash", async function (this: ChatticusWorld, code: string) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "error", JSON.stringify(outcome));
	if (outcome.status === "error") {
		assert.equal(outcome.code, code);
		assert.equal(outcome.current_sha256, treeHashOfDirectory(pathInWorkspace(this, "tree")));
	}
});

Then("the result does not contain {string}", async function (this: ChatticusWorld, text: string) {
	assert.ok(!JSON.stringify(await lastOutcomeOf(this)).includes(text));
});

Then("the result is ok with {int} entries removed", async function (this: ChatticusWorld, removed: number) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	if (outcome.status === "ok" && outcome.result.kind === "delete") assert.equal(outcome.result.removed, removed);
	else assert.fail(JSON.stringify(outcome));
});

Then("the result lists these entries in order:", async function (this: ChatticusWorld, table: DataTable) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	if (outcome.status !== "ok" || outcome.result.kind !== "list") return assert.fail(JSON.stringify(outcome));
	const listed = outcome.result.entries.map((entry) => ({
		name: entry.name,
		kind: entry.kind,
		size: entry.size === null ? "" : String(entry.size),
		link_target: entry.link_target ?? "",
	}));
	assert.deepEqual(listed, table.hashes());
});

Then("{string} is still a symbolic link to {string}", function (this: ChatticusWorld, name: string, target: string) {
	assert.ok(lstatSync(pathInWorkspace(this, name)).isSymbolicLink(), `${name} is not a link any more.`);
	assert.equal(readlinkSync(pathInWorkspace(this, name)), target);
});

Then("{string} does not exist", function (this: ChatticusWorld, name: string) {
	assert.equal(existsSyncOrLink(pathInWorkspace(this, name)), false, `${name} exists.`);
});

Then("the workspace still holds {string}", function (this: ChatticusWorld, name: string) {
	assert.ok(existsSync(pathInWorkspace(this, name)), `${name} is gone.`);
});

Then("no helper process is left running", function (this: ChatticusWorld) {
	const launcher = supervisorScenarioOf(this).fileHelper;
	assert.equal(launcher.running, 0);
	assert.equal(launcher.killedAtTimeout, 1);
});

Then("the sweep of the shell user's processes has not run yet", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).table.listings, 0);
});

Then("the file operation finishes with its own result", async function (this: ChatticusWorld) {
	const outcome = await lastOutcomeOf(this);
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	if (outcome.status === "ok" && outcome.result.kind === "read") assert.equal(outcome.result.content, "running");
	else assert.fail(JSON.stringify(outcome));
});

Then("the sweep ran after it finished", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const result = scenario.plane.fileResults.at(-1);
	assert.ok(result, "No file result was posted.");
	const listedAt = liveFileScenarioOf(this).marks.get("sweep-listed-at");
	assert.ok(listedAt !== undefined, "The sweep did not run.");
	assert.ok(listedAt >= result.atMilliseconds, `The sweep ran at ${listedAt}, before the result at ${result.atMilliseconds}.`);
});

Then("the write finishes and its result is posted", async function (this: ChatticusWorld) {
	await advanceUntil(this, () => postedOutcomeOf(this, "file-operation-1") !== null, 10);
	const outcome = postedOutcomeOf(this, "file-operation-1");
	assert.ok(outcome, "The write was not answered.");
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	assert.equal(readFileSync(pathInWorkspace(this, "stop-edit.txt"), "utf8"), "edited while stopping");
});

Then("the waiting request is answered {string}", async function (this: ChatticusWorld, code: string) {
	await advanceUntil(this, () => postedOutcomeOf(this, "file-operation-3") !== null, 10);
	const outcome = postedOutcomeOf(this, "file-operation-3");
	assert.ok(outcome, "The waiting request was not answered.");
	assert.equal(outcome.status, "error", JSON.stringify(outcome));
	if (outcome.status === "error") assert.equal(outcome.code, code);
});

Then("the final publish includes the written file", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	await advanceUntil(this, () => scenario.disk.publishedAtMilliseconds.length > 0, 15);
	const write = scenario.plane.fileResults.find((recorded) => recorded.request.operation_id === "file-operation-1");
	assert.ok(write, "The write was not posted.");
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 1, `Publishes: ${scenario.disk.publishedAtMilliseconds.length}. Log: ${scenario.logs.join(" | ")}`);
	assert.ok(scenario.disk.publishedAtMilliseconds[0]! >= write.atMilliseconds, "The publish finished before the write was posted.");
	assert.equal(readFileSync(pathInWorkspace(this, "stop-edit.txt"), "utf8"), "edited while stopping");
});

Then("the idle clock starts again", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const before = liveFileScenarioOf(this).marks.get("log-index-before-write") ?? 0;
	const restarted = scenario.logs.slice(before).filter((line) => line.startsWith("owner_idle ") && line.includes("idle_seconds=0"));
	assert.equal(restarted.length, 1, `Log since the write: ${scenario.logs.slice(before).join(" | ")}`);
});

Then("a publish is due in 30 seconds", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const answeredAt = liveFileScenarioOf(this).marks.get("write-answered-at")!;
	await scenario.clock.advance(28_000);
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 0, "The publish ran before the quiet period was over.");
	await scenario.clock.advance(5_000);
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 1, `Log: ${scenario.logs.join(" | ")}`);
	const publishedAt = scenario.disk.publishedAtMilliseconds[0]!;
	assert.ok(publishedAt >= answeredAt + 30_000 && publishedAt <= answeredAt + 33_000, `Published ${publishedAt - answeredAt} ms after the write.`);
});

Then("the log line {string} has the fields {string}, {string}, {string}, {string} and {string}", function (this: ChatticusWorld, event: string, first: string, second: string, third: string, fourth: string, fifth: string) {
	const lines = logLinesOf(this, event);
	assert.equal(lines.length, 1, `Lines: ${lines.join(" | ")}`);
	for (const field of [first, second, third, fourth, fifth]) assert.ok(new RegExp(`(^| )${field}=`).test(lines[0]!), `${field} is missing in: ${lines[0]}`);
	const expectedHash = createHash("sha256").update("/workspace/secret-plans.md").digest("hex").slice(0, 12);
	assert.ok(lines[0]!.includes(`path_hash=${expectedHash}`), lines[0]);
});

Then("no log line contains {string}", function (this: ChatticusWorld, text: string) {
	const offending = supervisorScenarioOf(this).logs.filter((line) => line.includes(text));
	assert.deepEqual(offending, []);
});

Then("the supervisor ends as superseded", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	await advanceUntil(this, () => scenario.exitCode !== null, 5);
	assert.equal(scenario.exitCode, 5, `Exit code ${scenario.exitCode}. Log: ${scenario.logs.join(" | ")}`);
});

function existsSyncOrLink(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
