import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import * as tar from "tar";
import { orgTenantIdFromPath } from "../../src/auth/principal.ts";
import { computerForOrganization } from "../../src/domain/computers.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { indexChecksumOf, parseIndex, serializeIndex } from "../../src/snapshot/index-format.ts";
import { unpackLiveDisk } from "../../src/snapshot/pack.ts";
import { reindexSnapshots, type ReindexResult } from "../../src/snapshot/reindex.ts";
import { snapshotUri } from "../../src/snapshot/uri.ts";
import { WORKSPACE_DIRNAME } from "../../src/browser-profiles.ts";
import { capturedConsoleLines, parsedLogLines } from "../log-capture-support.ts";
import { bearerFor } from "../front-door.ts";
import { ensureTestOrganization, organizationMemberHeaders } from "../org-user-client.ts";
import { sendFileRoute } from "../computer-file-live-support.ts";
import { cleanUpFileRoutesScenario, computerDiskOf, createFileRoutesBucket, fileRoutesOf, type FileRouteResponse } from "../computer-snapshot-files-support.ts";
import type { ChatticusWorld } from "../world.ts";

const TENANT = "anthus";

After(async function (this: ChatticusWorld) {
	await cleanUpFileRoutesScenario(this);
});

const sha256Of = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

function workspacePath(world: ChatticusWorld, relative: string): string {
	return join(computerDiskOf(world).liveRoot, WORKSPACE_DIRNAME, relative);
}

function writeWorkspace(world: ChatticusWorld, relative: string, content: string | Buffer): void {
	const path = workspacePath(world, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function responseOf(world: ChatticusWorld): FileRouteResponse {
	const response = fileRoutesOf(world).response;
	assert.ok(response, "No file route has been called in this scenario.");
	return response;
}

async function call(world: ChatticusWorld, headers: Record<string, string>, tenantId: string, route: string, query: Record<string, string>): Promise<void> {
	const search = new URLSearchParams(query).toString();
	await sendFileRoute(world, { method: "GET", path: `/orgs/${tenantId}/computer/files${route}${search === "" ? "" : `?${search}`}`, headers });
}

async function callAsMember(world: ChatticusWorld, route: string, query: Record<string, string>): Promise<void> {
	const path = `/orgs/${TENANT}/computer/files`;
	assert.equal(orgTenantIdFromPath(path), TENANT);
	await call(world, await organizationMemberHeaders(world, path), TENANT, route, query);
}

const decodePath = (path: string): string => path.replaceAll("<NUL>", "\u0000");

Given("a snapshot bucket for the computer file routes", async function (this: ChatticusWorld) {
	await createFileRoutesBucket(this);
});

Given(
	"the computer disk holds workspace file {string} containing {string}",
	function (this: ChatticusWorld, relative: string, content: string) {
		writeWorkspace(this, relative, content);
	},
);

Given(
	"the computer disk holds workspace file {string} of {int} bytes of repeating text",
	function (this: ChatticusWorld, relative: string, size: number) {
		const unit = "0123456789abcdef";
		writeWorkspace(this, relative, unit.repeat(Math.ceil(size / unit.length)).slice(0, size));
	},
);

Given("the computer disk holds workspace file {string} with binary content", function (this: ChatticusWorld, relative: string) {
	writeWorkspace(this, relative, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]));
});

Given("the computer disk holds sparse workspace file {string} of {int} bytes", function (this: ChatticusWorld, relative: string, size: number) {
	const path = workspacePath(this, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	const descriptor = openSync(path, "w");
	ftruncateSync(descriptor, size);
	closeSync(descriptor);
});

Given(
	"the computer disk holds {int} workspace files in directory {string}",
	function (this: ChatticusWorld, count: number, directory: string) {
		for (let number = 0; number < count; number += 1) {
			writeWorkspace(this, `${directory}/file-${String(number).padStart(5, "0")}.txt`, `file ${number}`);
		}
	},
);

Given("the computer disk holds workspace link {string} pointing to {string}", function (this: ChatticusWorld, relative: string, target: string) {
	const path = workspacePath(this, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	symlinkSync(target, path);
});

async function publishComputerDisk(world: ChatticusWorld): Promise<void> {
	const scenario = fileRoutesOf(world);
	assert.ok(scenario.bucket, "The scenario has no snapshot bucket for the file routes.");
	const store = world.messagingStore();
	const computer = await computerForOrganization(TENANT, { store });
	const manifest = await computerDiskOf(world).publish({ tenant_id: TENANT, computer_id: computer.computerId, worker_id: "file-routes-host" });
	await store.putComputer({
		...computer,
		snapshotUri: snapshotUri(TENANT, computer.computerId, { bucket: scenario.bucket }),
		snapshotChecksum: manifest.checksum,
	});
	scenario.computerRecordAfterPublish = JSON.stringify(await computerForOrganization(TENANT, { store }));
	scenario.manifest = manifest;
}

When("the computer disk is published", async function (this: ChatticusWorld) {
	await publishComputerDisk(this);
});

When("the computer disk is published again without any change", async function (this: ChatticusWorld) {
	const first = fileRoutesOf(this).manifest;
	assert.ok(first, "Nothing was published yet.");
	await publishComputerDisk(this);
	const second = fileRoutesOf(this).manifest;
	assert.equal(second?.checksum, first.checksum);
	assert.equal(second?.index_checksum, first.index_checksum);
});

async function storedFiles(world: ChatticusWorld) {
	const scenario = fileRoutesOf(world);
	const store = scenario.publisherStore!;
	const computer = await computerForOrganization(TENANT, { store: world.messagingStore() });
	const uri = snapshotUri(TENANT, computer.computerId, { bucket: scenario.bucket });
	return { store, uri };
}

When("the published snapshot is replaced by one made before indexes existed", async function (this: ChatticusWorld) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	const legacyPack = await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		const stream = tar.create({ gzip: true, cwd: computerDiskOf(this).liveRoot, portable: true }, ["workspace", "browser-profiles"]);
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
	await store.putPack(uri, (async function* () { yield legacyPack; })());
	const { index_checksum: _dropped, ...withoutIndex } = manifest;
	void _dropped;
	await store.putManifest(uri, { ...withoutIndex, checksum: sha256Of(legacyPack) });
	fileRoutesOf(this).manifest = { ...withoutIndex, checksum: sha256Of(legacyPack) };
});

When("the published snapshot claims a different hash for {string}", async function (this: ChatticusWorld, indexedPath: string) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	const index = parseIndex(await store.getIndexBytes(uri, manifest.checksum));
	const entry = index.entries.find((candidate) => candidate.path === indexedPath);
	assert.ok(entry, `The index has no entry ${indexedPath}.`);
	entry.sha256 = "0".repeat(64);
	const serialized = serializeIndex(index);
	await store.putIndex(uri, manifest.checksum, serialized);
	await store.putManifest(uri, { ...manifest, index_checksum: indexChecksumOf(serialized) });
});

When("a new hydrating host restores the published snapshot", async function (this: ChatticusWorld) {
	const { store, uri } = await storedFiles(this);
	const root = mkdtempSync(join(tmpdir(), "restored-"));
	fileRoutesOf(this).restoredRoot = root;
	await unpackLiveDisk(await store.getPack(uri), root);
});

Then("the restored workspace has file {string} containing {string}", function (this: ChatticusWorld, relative: string, content: string) {
	assert.equal(readFileSync(join(fileRoutesOf(this).restoredRoot as string, WORKSPACE_DIRNAME, relative), "utf8"), content);
});

Then("the restored workspace has no {string}", function (this: ChatticusWorld, relative: string) {
	assert.equal(existsSync(join(fileRoutesOf(this).restoredRoot as string, WORKSPACE_DIRNAME, relative)), false);
});

Then("the host wrote the pack, then the index, then the manifest", function (this: ChatticusWorld) {
	const puts = fileRoutesOf(this).publisherRequests.filter((request) => request.action === "s3:PutObject").map((request) => request.keys[0]!);
	const order = ["snapshot.tar.gz", "/index/", "manifest.json"].map((part) => puts.findIndex((key) => key.includes(part)));
	assert.ok(order.every((position) => position >= 0), `Expected pack, index and manifest writes, saw ${puts.join(", ")}.`);
	assert.deepEqual([...order].sort((left, right) => left - right), order, `The writes were out of order: ${puts.join(", ")}.`);
});

Then("the manifest names the index that was written next to the pack", async function (this: ChatticusWorld) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	assert.ok(manifest.index_checksum, "The manifest names no index.");
	const bytes = await store.getIndexBytes(uri, manifest.checksum);
	assert.equal(indexChecksumOf(bytes), manifest.index_checksum);
	assert.equal(parseIndex(bytes).pack_checksum, manifest.checksum);
});

Then("the index lists {string} as a file of {int} bytes", async function (this: ChatticusWorld, indexedPath: string, size: number) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	const entry = parseIndex(await store.getIndexBytes(uri, manifest.checksum)).entries.find((candidate) => candidate.path === indexedPath);
	assert.ok(entry, `The index has no entry ${indexedPath}.`);
	assert.equal(entry.kind, "file");
	assert.equal(entry.size, size);
	assert.match(entry.sha256 ?? "", /^[0-9a-f]{64}$/);
	assert.ok((entry.length ?? 0) > 0);
});

Then("the index lists nothing whose path contains {string}", async function (this: ChatticusWorld, fragment: string) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	const offenders = parseIndex(await store.getIndexBytes(uri, manifest.checksum)).entries.filter((entry) => entry.path.includes(fragment));
	assert.deepEqual(offenders.map((entry) => entry.path), []);
});

Then("the index lists {string}", async function (this: ChatticusWorld, indexedPath: string) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	assert.ok(parseIndex(await store.getIndexBytes(uri, manifest.checksum)).entries.some((entry) => entry.path === indexedPath));
});

Then("the console reports the skipped file {string}", function (this: ChatticusWorld, indexedPath: string) {
	const skipped = parsedLogLines(capturedConsoleLines(this)).filter((line) => line.event === "snapshot_file_skipped");
	assert.ok(skipped.some((line) => line.fields.get("path") === indexedPath), `No snapshot_file_skipped line for ${indexedPath}: ${skipped.map((line) => line.text).join(" | ")}`);
});

Then("the console reports a corrupt snapshot member for {string}", function (this: ChatticusWorld, apiPath: string) {
	const lines = parsedLogLines(capturedConsoleLines(this)).filter((line) => line.event === "snapshot_member_corrupt");
	assert.ok(lines.some((line) => line.fields.get("path") === apiPath), `No snapshot_member_corrupt line for ${apiPath}.`);
});

When("a member lists the computer files at {string}", async function (this: ChatticusWorld, path: string) {
	await callAsMember(this, "", { path: decodePath(path) });
});

When("a member lists the computer files with no path", async function (this: ChatticusWorld) {
	await callAsMember(this, "", {});
});

When("a member stats the computer file {string}", async function (this: ChatticusWorld, path: string) {
	await callAsMember(this, "/stat", { path: decodePath(path) });
});

When("a member reads the computer file {string}", async function (this: ChatticusWorld, path: string) {
	await callAsMember(this, "/content", { path: decodePath(path) });
});

When(
	"a member reads {int} bytes of the computer file {string} from offset {int}",
	async function (this: ChatticusWorld, length: number, path: string, offset: number) {
		await callAsMember(this, "/content", { path: decodePath(path), offset: String(offset), length: String(length) });
	},
);

When("a member reads the computer file whose path is {int} characters long", async function (this: ChatticusWorld, characters: number) {
	await callAsMember(this, "/content", { path: `/workspace/${"a".repeat(characters - "/workspace/".length)}` });
});

When("a member of {string} lists the computer files of {string} at {string}", async function (this: ChatticusWorld, memberTenant: string, tenantId: string, path: string) {
	await ensureTestOrganization(this, tenantId);
	const neighbor = `member@${memberTenant}.example`;
	await new OrganizationsKernelImpl().adminSeedOrganization(memberTenant, neighbor, memberTenant, {
		store: this.messagingStore(),
		clock: this.clock,
		ids: this.ids,
	});
	await call(this, await bearerFor(this, neighbor), tenantId, "", { path });
});

When("someone who belongs to no organization lists the computer files of {string} at {string}", async function (this: ChatticusWorld, tenantId: string, path: string) {
	await ensureTestOrganization(this, tenantId);
	await call(this, await bearerFor(this, "stranger@nowhere.example"), tenantId, "", { path });
});

Then("the file response status is {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(responseOf(this).status, status, responseOf(this).text);
});

Then("the file response error is {string}", function (this: ChatticusWorld, code: string) {
	const response = responseOf(this);
	assert.equal(response.json?.error, code, response.text);
	assert.equal(typeof response.json?.message, "string");
});

Then("the file response says {string} is {string}", function (this: ChatticusWorld, field: string, expected: string) {
	assert.equal(String(responseOf(this).json?.[field]), expected, responseOf(this).text);
});

Then("the file response carries header {string} as {string}", function (this: ChatticusWorld, name: string, expected: string) {
	assert.equal(responseOf(this).headers.get(name), expected);
});

Then("the file response was published as of the manifest time", async function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.json?.source, "snapshot");
	const manifest = fileRoutesOf(this).manifest;
	assert.ok(manifest, "Nothing was published.");
	assert.equal(response.json?.as_of, manifest.published_at);
});

Then("the listing shows these entries in order:", function (this: ChatticusWorld, table: DataTable) {
	const rows = table.hashes() as Array<{ name: string; kind: string }>;
	const actual = (responseOf(this).json?.entries ?? []).map((entry: { name: string; kind: string }) => ({ name: entry.name, kind: entry.kind }));
	assert.deepEqual(actual, rows.map((row) => ({ name: row.name, kind: row.kind })));
});

Then("the listing has {int} entries and truncated is {word}", function (this: ChatticusWorld, count: number, truncated: string) {
	const json = responseOf(this).json;
	assert.equal(json?.entries?.length, count);
	assert.equal(String(json?.truncated), truncated);
});

Then("the listing has no entry named {string}", function (this: ChatticusWorld, name: string) {
	assert.ok(!(responseOf(this).json?.entries ?? []).some((entry: { name: string }) => entry.name === name));
});

Then(
	"the entry {string} is a {word} of {int} bytes with SHA-256 of {string}",
	function (this: ChatticusWorld, name: string, kind: string, size: number, content: string) {
		const json = responseOf(this).json;
		const entry = json?.entries?.find((candidate: { name: string }) => candidate.name === name) ?? json?.entry;
		assert.ok(entry, responseOf(this).text);
		assert.equal(entry.kind, kind);
		assert.equal(entry.size, size);
		assert.equal(entry.sha256, sha256Of(content));
		assert.match(entry.mode, /^[0-7]{3}$/);
	},
);

Then("the entry {string} is a symlink to {string}", function (this: ChatticusWorld, name: string, target: string) {
	const entry = responseOf(this).json?.entries?.find((candidate: { name: string }) => candidate.name === name);
	assert.ok(entry, responseOf(this).text);
	assert.equal(entry.kind, "symlink");
	assert.equal(entry.link_target, target);
	assert.equal(entry.size, null);
});

Then("the content response holds {string}", function (this: ChatticusWorld, content: string) {
	const json = responseOf(this).json;
	assert.equal(json?.content, content, responseOf(this).text);
	assert.equal(json?.encoding, "utf8");
	assert.equal(json?.binary, false);
	assert.equal(json?.masked, false);
});

Then("the content response has the SHA-256 of {string} and the same ETag", function (this: ChatticusWorld, wholeFile: string) {
	const response = responseOf(this);
	assert.equal(response.json?.sha256, sha256Of(wholeFile));
	assert.equal(response.headers.get("ETag"), `"${sha256Of(wholeFile)}"`);
});

Then("the content response returns {int} bytes from offset {int} and truncated is {word}", function (this: ChatticusWorld, length: number, offset: number, truncated: string) {
	const json = responseOf(this).json;
	assert.equal(json?.length, length);
	assert.equal(json?.offset, offset);
	assert.equal(Buffer.byteLength(json?.content ?? "", "utf8"), length);
	assert.equal(String(json?.truncated), truncated);
});

Then("the content response is binary base64 of {int} bytes", function (this: ChatticusWorld, length: number) {
	const json = responseOf(this).json;
	assert.equal(json?.binary, true);
	assert.equal(json?.encoding, "base64");
	assert.equal(Buffer.from(json?.content ?? "", "base64").length, length);
});

Then("the content response is masked and empty", function (this: ChatticusWorld) {
	const json = responseOf(this).json;
	assert.equal(json?.masked, true);
	assert.equal(json?.content, "");
	assert.equal(typeof json?.sha256, "string");
});

Then("the response body does not contain {string}", function (this: ChatticusWorld, text: string) {
	assert.ok(!responseOf(this).text.includes(text), `The body contains ${text}.`);
});

Then("the file routes made no writes", async function (this: ChatticusWorld) {
	const scenario = fileRoutesOf(this);
	assert.ok(scenario.readerRequests.length > 0, "The file routes sent no S3 request at all.");
	const actions = new Set(scenario.readerRequests.map((request) => request.action));
	assert.deepEqual([...actions], ["s3:GetObject"]);
	const record = JSON.stringify(await computerForOrganization(TENANT, { store: this.messagingStore() }));
	assert.equal(record, scenario.computerRecordAfterPublish, "A file route changed the computer record.");
});

const reindexResults = new WeakMap<ChatticusWorld, ReindexResult[]>();

async function reindex(world: ChatticusWorld, execute: boolean): Promise<void> {
	const { store } = await storedFiles(world);
	const computer = await computerForOrganization(TENANT, { store: world.messagingStore() });
	reindexResults.set(world, await reindexSnapshots(store, [{ tenantId: TENANT, computerId: computer.computerId }], { execute }));
}

When("the snapshots are re-indexed as a dry run", async function (this: ChatticusWorld) {
	await reindex(this, false);
});

When("the snapshots are re-indexed for real", async function (this: ChatticusWorld) {
	await reindex(this, true);
});

Then("the re-index reports {string}", function (this: ChatticusWorld, outcome: string) {
	const results = reindexResults.get(this);
	assert.ok(results, "No re-index ran in this scenario.");
	assert.deepEqual(results.map((result) => result.outcome), [outcome], JSON.stringify(results));
});

Then("the manifest names no index", async function (this: ChatticusWorld) {
	const { store, uri } = await storedFiles(this);
	assert.equal((await store.getManifest(uri)).index_checksum, undefined);
});

Then("the manifest keeps its original publish time", async function (this: ChatticusWorld) {
	const { store, uri } = await storedFiles(this);
	const manifest = await store.getManifest(uri);
	assert.equal(manifest.published_at, fileRoutesOf(this).manifest?.published_at);
	assert.ok(manifest.index_checksum, "The manifest names no index.");
});
