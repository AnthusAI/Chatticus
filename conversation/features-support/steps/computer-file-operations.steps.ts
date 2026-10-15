import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { symlinkHashOf, treeHashOf, type LiveTreeDescendant } from "@chatticus/host-protocol/live-file-rules";
import { WORKSPACE_DIRNAME } from "../../src/browser-profiles.ts";
import { changeOverlay, loadEffectiveOverlayView, type OverlayMemberChange } from "../../src/domain/edit-overlay.ts";
import { hashOf, memberFilesOf, sendFileRoute, settleInFlight, untilRequestIsWaiting } from "../computer-file-live-support.ts";
import { computerDiskOf, fileRoutesOf } from "../computer-snapshot-files-support.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { overlayDependenciesOf, storedIndexOf } from "../edit-overlay-support.ts";
import { memberHeadersFor } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { ownerAnswersTheWaitingRequest } from "./computer-file-live.steps.ts";
import { auditRecordsOf, ownerOf } from "./live-files-owner.steps.ts";

const TENANT = STORY_TENANT;
const FILES = `/orgs/${TENANT}/computer/files`;
const MAX_ANSWER_ROUNDS = 6;

const sha256Of = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const workspaceFile = (relative: string): string => (relative.startsWith("/") ? relative : `/workspace/${relative}`);
const quoted = (hash: string): string => `"${hash}"`;
const unquoted = (etag: string | null): string => (etag ?? "").replaceAll('"', "");

const SEEN_HASH = '(the hash of "[^"]*"|the hash it was shown|the tree hash it was shown|the symlink hash it was shown)';

async function sendAs(
	world: ChatticusWorld,
	userId: string,
	call: { method: "GET" | "POST" | "DELETE"; path: string; headers?: Record<string, string>; body?: unknown },
) {
	const headers = { ...(await memberHeadersFor(world, TENANT, userId)), ...(call.headers ?? {}) };
	return sendFileRoute(world, {
		method: call.method,
		path: call.path,
		headers: call.body === undefined ? headers : { ...headers, "content-type": "application/json" },
		...(call.body === undefined ? {} : { body: call.body }),
	});
}

/** The hash the person is shown for a path: the `ETag` of its stat, answered by the owner when the computer runs. */
async function shownHashOf(world: ChatticusWorld, userId: string, path: string): Promise<string> {
	const scenario = memberFilesOf(world);
	const before = scenario.responses.length;
	let response = await sendAs(world, userId, { method: "GET", path: `${FILES}/stat?path=${encodeURIComponent(path)}` });
	if (response === null) response = await ownerAnswersTheWaitingRequest(world);
	assert.equal(response.status, 200, response.text);
	const etag = unquoted(response.headers.get("ETag"));
	assert.match(etag, /^[0-9a-f]{64}$/, `The stat of ${path} carried no ETag: ${response.text}`);
	scenario.responses.length = before;
	return etag;
}

async function seenHashOf(world: ChatticusWorld, userId: string, path: string, clause: string): Promise<string> {
	const literal = /^the hash of "(.*)"$/.exec(clause);
	return literal === null ? shownHashOf(world, userId, path) : hashOf(literal[1]!);
}

function deletePath(path: string, options: { recursive?: boolean; extraQuery?: string }): string {
	const recursive = options.recursive === true ? "&recursive=true" : "";
	const extra = options.extraQuery === undefined ? "" : `&${options.extraQuery}`;
	return `${FILES}?path=${encodeURIComponent(path)}${recursive}${extra}`;
}

async function deleteAs(world: ChatticusWorld, userId: string, path: string, options: { recursive?: boolean; hash?: string; extraQuery?: string }) {
	return sendAs(world, userId, {
		method: "DELETE",
		path: deletePath(path, options),
		...(options.hash === undefined ? {} : { headers: { "If-Match": quoted(options.hash) } }),
	});
}

async function moveAs(world: ChatticusWorld, userId: string, from: string, to: string, hash: string | undefined) {
	return sendAs(world, userId, {
		method: "POST",
		path: `${FILES}/move`,
		body: { from, to },
		...(hash === undefined ? {} : { headers: { "If-Match": quoted(hash) } }),
	});
}

async function makeFolderAs(world: ChatticusWorld, userId: string, path: string) {
	return sendAs(world, userId, { method: "POST", path: `${FILES}/directories`, body: { path } });
}

When(
	new RegExp(`^(?:member|the organization owner) "([^"]*)" deletes the computer (?:file|folder|path) "([^"]*)"( recursively| without recursion)? if it still has ${SEEN_HASH}$`),
	async function (this: ChatticusWorld, userId: string, path: string, mode: string | undefined, clause: string) {
		const hash = await seenHashOf(this, userId, path, clause);
		await deleteAs(this, userId, path, { recursive: mode === " recursively", hash });
	},
);

When(
	"member {string} deletes the computer file {string} if it still has the hash of {string} and the owner does not answer for {int} seconds",
	async function (this: ChatticusWorld, userId: string, path: string, text: string, seconds: number) {
		await deleteAs(this, userId, path, { hash: hashOf(text) });
		await settleInFlight(this, 0.25);
		assert.ok(seconds >= 8);
	},
);

When("member {string} deletes the computer file {string} sending no precondition", async function (this: ChatticusWorld, userId: string, path: string) {
	await deleteAs(this, userId, path, {});
});

When(
	/^member "([^"]*)" deletes the computer file "([^"]*)" sending the header "([^"]*)" as (.*)$/,
	async function (this: ChatticusWorld, userId: string, path: string, header: string, value: string) {
		await sendAs(this, userId, { method: "DELETE", path: deletePath(path, {}), headers: { [header]: value } });
	},
);

When(
	"member {string} deletes the computer file {string} with the query {string} if it still has the hash of {string}",
	async function (this: ChatticusWorld, userId: string, path: string, query: string, text: string) {
		await deleteAs(this, userId, path, { hash: hashOf(text), extraQuery: query });
	},
);

When("member {string} makes {int} delete requests within one minute", async function (this: ChatticusWorld, userId: string, count: number) {
	for (let number = 1; number <= count; number += 1) await deleteAs(this, userId, `/workspace/rate-${number}.md`, { hash: hashOf("x") });
});

When(
	new RegExp(`^member "([^"]*)" renames the computer (?:file|folder) "([^"]*)" to "([^"]*)" if it still has ${SEEN_HASH}$`),
	async function (this: ChatticusWorld, userId: string, from: string, to: string, clause: string) {
		const hash = await seenHashOf(this, userId, from, clause);
		await moveAs(this, userId, from, to, hash);
	},
);

When("member {string} renames the computer file {string} to {string} and sends no precondition", async function (this: ChatticusWorld, userId: string, from: string, to: string) {
	await moveAs(this, userId, from, to, undefined);
});

When("member {string} creates the computer folder {string}", async function (this: ChatticusWorld, userId: string, path: string) {
	await makeFolderAs(this, userId, path);
});

When(
	/^member "([^"]*)" (creates the folder|deletes the path|renames the path from|renames the path to) "([^"]*)"$/,
	async function (this: ChatticusWorld, userId: string, action: string, path: string) {
		switch (action) {
			case "creates the folder":
				await makeFolderAs(this, userId, path);
				return;
			case "deletes the path":
				await deleteAs(this, userId, path, { hash: hashOf("x") });
				return;
			case "renames the path from":
				await moveAs(this, userId, path, "/workspace/moved", hashOf("x"));
				return;
			default:
				await moveAs(this, userId, "/workspace/notes.md", path, hashOf("x"));
		}
	},
);

When("a member stats the computer folder {string}", async function (this: ChatticusWorld, path: string) {
	const response = await sendAs(this, "mia", { method: "GET", path: `${FILES}/stat?path=${encodeURIComponent(path)}` });
	if (response === null) await untilRequestIsWaiting(this);
});

/**
 * The owner takes each request the Front Door leaves for it and answers it from its disk, round after round, until the
 * member's request is answered.
 */
async function answerUntilTheChangeIsAnswered(world: ChatticusWorld): Promise<void> {
	const scenario = memberFilesOf(world);
	const owner = ownerOf(world);
	assert.ok(scenario.pending, "No file request is waiting for the owner.");
	for (let round = 0; round < MAX_ANSWER_ROUNDS; round += 1) {
		const looked = await scenario.wait.untilSettledOrParked(scenario.pending!);
		if (looked.settled) {
			await settleInFlight(world, 0);
			return;
		}
		const polled = await owner.poll();
		assert.equal(polled.status, 200, JSON.stringify(polled.body));
		const requests = owner.lastPoll?.file_requests ?? [];
		assert.ok(requests.length > 0, "The poll carried no file request for the owner to answer.");
		for (const request of requests) {
			const posted = await owner.postResult(request.operation_id, scenario.disk.answer(request));
			assert.equal(posted.status, 200, JSON.stringify(posted.body));
		}
		scenario.wait.release();
	}
	assert.fail("The owner answered every request and the change was still not answered.");
}

When("the owner answers every file request until the change is answered", async function (this: ChatticusWorld) {
	await answerUntilTheChangeIsAnswered(this);
});

When("a member lists the pending changes", async function (this: ChatticusWorld) {
	await sendAs(this, "mia", { method: "GET", path: `${FILES}/overlay` });
});

When("member {string} discards the pending change of {string}", async function (this: ChatticusWorld, userId: string, path: string) {
	const scenario = memberFilesOf(this);
	const listed = await sendAs(this, userId, { method: "GET", path: `${FILES}/overlay` });
	assert.ok(listed && listed.status === 200, listed?.text);
	const entry = (listed.json.entries as Array<{ path: string; revision: number }>).find((candidate) => candidate.path === path);
	assert.ok(entry, `There is no pending change of ${path}.`);
	scenario.responses.length = 0;
	await sendAs(this, userId, { method: "POST", path: `${FILES}/overlay/discard`, body: { path, revision: entry.revision } });
});

function workspaceDirectory(world: ChatticusWorld, relative: string): string {
	return join(computerDiskOf(world).liveRoot, WORKSPACE_DIRNAME, relative);
}

Given("the computer disk holds an empty folder {string}", function (this: ChatticusWorld, relative: string) {
	mkdirSync(workspaceDirectory(this, relative), { recursive: true });
});

Given("the live disk of the owner holds an empty folder {string}", function (this: ChatticusWorld, relative: string) {
	memberFilesOf(this).disk.putDirectory(workspaceFile(relative));
});

export async function changeAs(world: ChatticusWorld, userId: string, request: OverlayMemberChange): Promise<void> {
	await changeOverlay(overlayDependenciesOf(world), { tenantId: TENANT, userId, request });
}

export async function effectiveHashOf(world: ChatticusWorld, path: string): Promise<string> {
	const { view } = await loadEffectiveOverlayView(overlayDependenciesOf(world), TENANT);
	const hash = view.hashOf(path);
	assert.ok(hash !== null, `There is nothing at ${path}.`);
	return hash;
}

export async function renameInOverlay(world: ChatticusWorld, userId: string, from: string, to: string): Promise<void> {
	await changeAs(world, userId, { op: "move", from, to, ifMatchSha256: await effectiveHashOf(world, from) });
}

Given("member {string} renamed the folder {string} to {string} while the computer was off", async function (this: ChatticusWorld, userId: string, from: string, to: string) {
	await renameInOverlay(this, userId, from, to);
});

Given("member {string} renamed {string} to {string} while the computer was off", async function (this: ChatticusWorld, userId: string, from: string, to: string) {
	await renameInOverlay(this, userId, from, to);
});

Given("member {string} created {string} with {string} while the computer was off", async function (this: ChatticusWorld, userId: string, path: string, content: string) {
	await changeAs(this, userId, { op: "put", path, content, precondition: { type: "if_none_match" } });
});

Given(
	"member {string} deleted {string} and renamed {string} to {string} and created the folder {string} while the computer was off",
	async function (this: ChatticusWorld, userId: string, deleted: string, from: string, to: string, folder: string) {
		await changeAs(this, userId, { op: "delete", path: deleted, recursive: false, ownerRole: false, ifMatchSha256: await effectiveHashOf(this, deleted) });
		await renameInOverlay(this, userId, from, to);
		await changeAs(this, userId, { op: "mkdir", path: folder });
	},
);

Given(/^member "([^"]*)" has created (\d+) folders and (\d+) files? while the computer is off$/, async function (this: ChatticusWorld, userId: string, folders: string, files: string) {
	for (let number = 0; number < Number(folders); number += 1) await changeAs(this, userId, { op: "mkdir", path: `/workspace/folder-${number}` });
	for (let number = 0; number < Number(files); number += 1) {
		await changeAs(this, userId, { op: "put", path: `/workspace/file-${number}.md`, content: `file ${number}`, precondition: { type: "if_none_match" } });
	}
});

function lastResponse(world: ChatticusWorld) {
	const response = fileRoutesOf(world).response;
	assert.ok(response, "No file route has been called in this scenario.");
	return response;
}

function treeHashOfTable(table: DataTable): string {
	const descendants = (table.hashes() as Array<{ kind: string; path: string; value: string }>).map((row): LiveTreeDescendant => {
		if (row.kind === "file") return { relativePath: row.path, kind: "file", size: Number(row.value) };
		if (row.kind === "symlink") return { relativePath: row.path, kind: "symlink", target: row.value };
		return { relativePath: row.path, kind: "dir" };
	});
	return treeHashOf(descendants, sha256Of);
}

function treeOfDirectory(directory: string, relative = ""): LiveTreeDescendant[] {
	const found: LiveTreeDescendant[] = [];
	for (const name of readdirSync(join(directory, relative))) {
		const relativePath = relative === "" ? name : `${relative}/${name}`;
		const stats = lstatSync(join(directory, relativePath));
		if (stats.isSymbolicLink()) found.push({ relativePath, kind: "symlink", target: readlinkSync(join(directory, relativePath)) });
		else if (stats.isDirectory()) {
			found.push({ relativePath, kind: "dir" }, ...treeOfDirectory(directory, relativePath));
		} else found.push({ relativePath, kind: "file", size: stats.size });
	}
	return found;
}

Then("the file response carries the ETag of the tree hash of these entries:", function (this: ChatticusWorld, table: DataTable) {
	assert.equal(unquoted(lastResponse(this).headers.get("ETag")), treeHashOfTable(table));
});

Then("the stat entry has the same tree hash", function (this: ChatticusWorld) {
	const response = lastResponse(this);
	assert.equal(response.json?.entry?.tree_sha256, unquoted(response.headers.get("ETag")));
});

Then("the file response carries the ETag of the content hash of {string}", function (this: ChatticusWorld, text: string) {
	assert.equal(unquoted(lastResponse(this).headers.get("ETag")), sha256Of(text));
});

Then("the stat entry has the content hash of {string}", function (this: ChatticusWorld, text: string) {
	assert.equal(lastResponse(this).json?.entry?.sha256, sha256Of(text));
});

Then("the owner was given these kinds of file request in order:", function (this: ChatticusWorld, table: DataTable) {
	assert.deepEqual(memberFilesOf(this).disk.requestKinds, table.raw().map((row) => row[0]));
});

Then("the file response carries the ETag of the link to {string}", function (this: ChatticusWorld, target: string) {
	assert.equal(unquoted(lastResponse(this).headers.get("ETag")), symlinkHashOf(target, sha256Of));
});

Then("the listing is empty", function (this: ChatticusWorld) {
	assert.deepEqual(lastResponse(this).json?.entries, []);
});

Then("the live disk of the owner has {string}", function (this: ChatticusWorld, path: string) {
	assert.ok(memberFilesOf(this).disk.has(workspaceFile(path)), `The live disk has no ${path}.`);
});

Then("the live disk of the owner has no {string}", function (this: ChatticusWorld, path: string) {
	assert.ok(!memberFilesOf(this).disk.has(workspaceFile(path)), `The live disk still has ${path}.`);
});

async function entriesOfOverlay(world: ChatticusWorld) {
	return (await storedIndexOf(world))?.entries ?? [];
}

Then("the overlay holds no entry", async function (this: ChatticusWorld) {
	assert.deepEqual(await entriesOfOverlay(this), []);
});

Then("the overlay holds one entry", async function (this: ChatticusWorld) {
	assert.equal((await entriesOfOverlay(this)).length, 1, JSON.stringify(await entriesOfOverlay(this)));
});

Then(
	"the overlay holds a move from {string} to {string} with the hash of {string} and no blob",
	async function (this: ChatticusWorld, from: string, to: string, text: string) {
		const entries = await entriesOfOverlay(this);
		assert.equal(entries.length, 1, JSON.stringify(entries));
		const entry = entries[0]!;
		assert.equal(entry.op, "move");
		if (entry.op !== "move") return;
		assert.equal(entry.from, from);
		assert.equal(entry.path, to);
		assert.equal(entry.sha256, hashOf(text));
		const blobs = await overlayBlobCount(this);
		assert.equal(blobs, 0, "A rename must not store a copy of the file.");
	},
);

async function overlayBlobCount(world: ChatticusWorld): Promise<number> {
	const entries = await entriesOfOverlay(world);
	return entries.filter((entry) => entry.op === "put").length;
}

Then("the overlay holds one delete of the folder {string} with the tree hash of the saved copy", async function (this: ChatticusWorld, path: string) {
	const entries = await entriesOfOverlay(this);
	assert.equal(entries.length, 1, JSON.stringify(entries));
	const entry = entries[0]!;
	assert.equal(entry.op, "delete");
	if (entry.op !== "delete") return;
	assert.equal(entry.path, path);
	assert.equal(entry.directory, true);
	assert.equal(entry.recursive, true);
	const savedFolder = workspaceDirectory(this, path.slice("/workspace/".length));
	assert.equal(entry.tree_sha256, treeHashOf(treeOfDirectory(savedFolder), sha256Of));
});

Then(
	/^the pending changes are a delete of "([^"]*)", a move from "([^"]*)" to "([^"]*)" and a mkdir of "([^"]*)"$/,
	function (this: ChatticusWorld, deleted: string, from: string, to: string, folder: string) {
		const response = lastResponse(this);
		assert.equal(response.status, 200, response.text);
		const summary = (response.json.entries as Array<{ op: string; path: string; from?: string }>)
			.map((entry) => (entry.op === "move" ? `move ${entry.from} ${entry.path}` : `${entry.op} ${entry.path}`))
			.sort();
		assert.deepEqual(summary, [`delete ${deleted}`, `mkdir ${folder}`, `move ${from} ${to}`].sort());
	},
);

Then("the audit log has one record with operation {string}", async function (this: ChatticusWorld, operation: string) {
	const records = (await this.messagingStore().listFileAuditRecords(TENANT, this.clock.now())).filter((record) => record.operation === operation);
	assert.equal(records.length, 1, JSON.stringify(records));
});

Then("the audit log has two records for member {string} with operation {string}", async function (this: ChatticusWorld, userId: string, operation: string) {
	const records = (await auditRecordsOf(this, userId)).filter((record) => record.operation === operation);
	assert.equal(records.length, 2, JSON.stringify(records));
});

const RECORD_FIELDS: Record<string, string> = {
	operation: "operation",
	path: "path",
	to_path: "toPath",
	outcome: "outcome",
	source: "source",
	sha256_before: "sha256Before",
};

function cellValue(cell: string): string | undefined {
	if (cell === "") return undefined;
	const literal = /^the hash of "(.*)"$/.exec(cell);
	return literal === null ? cell : hashOf(literal[1]!);
}

Then("the audit log has these records for member {string}:", async function (this: ChatticusWorld, userId: string, table: DataTable) {
	const records = await auditRecordsOf(this, userId);
	const rows = table.hashes() as Array<Record<string, string>>;
	assert.equal(records.length, rows.length, JSON.stringify(records));
	for (const row of rows) {
		const matched = records.some((record) =>
			Object.entries(RECORD_FIELDS).every(([column, field]) => (record as unknown as Record<string, unknown>)[field] === cellValue(row[column] ?? "")),
		);
		assert.ok(matched, `No audit record matches ${JSON.stringify(row)} in ${JSON.stringify(records)}.`);
	}
});
