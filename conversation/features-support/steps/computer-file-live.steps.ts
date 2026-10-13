import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { LIVE_FILE_AUDIT_RETENTION_DAYS, LIVE_FILE_MAX_OPEN_OPERATIONS, type LiveFileOutcome, type OwnerFileRequest } from "@chatticus/host-protocol/live-files";
import { computerForOrganization } from "../../src/domain/computers.ts";
import { changeOverlay } from "../../src/domain/edit-overlay.ts";
import { newLiveFileOperationId, queueLiveFileRequest } from "../../src/domain/live-files.ts";
import { snapshotUri } from "../../src/snapshot/uri.ts";
import {
	hashOf,
	readRouteResponse,
	memberFilesOf,
	resolveValue,
	sendFileRoute,
	settleInFlight,
	untilRequestIsWaiting,
} from "../computer-file-live-support.ts";
import { fileRoutesOf } from "../computer-snapshot-files-support.ts";
import { overlayDependenciesOf } from "../edit-overlay-support.ts";
import { bearerFor } from "../front-door.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { ensureMember, memberHeadersFor } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { auditRecordsOf, dependenciesOf, ownerOf, startLiveOwner } from "./live-files-owner.steps.ts";

const TENANT = STORY_TENANT;
const FILES = `/orgs/${TENANT}/computer/files`;
const SIX_HUNDRED_SECONDS = 600;

const workspaceFile = (relative: string): string => (relative.startsWith("/") ? relative : `/workspace/${relative}`);

type Member = Record<string, string>;

const putHeaders = (headers: Member, precondition: Member): Member => ({ ...headers, "content-type": "application/json", ...precondition });

const ifMatch = (text: string): Member => ({ "If-Match": `"${hashOf(text)}"` });
const ifNoneMatch: Member = { "If-None-Match": "*" };

async function putContent(world: ChatticusWorld, userId: string, tenantId: string, path: string, content: string, precondition: Member): Promise<void> {
	const headers = await memberHeadersFor(world, tenantId, userId);
	await sendFileRoute(world, {
		method: "PUT",
		path: `/orgs/${tenantId}/computer/files/content?path=${encodeURIComponent(path)}`,
		headers: putHeaders(headers, precondition),
		body: { content },
	});
}

async function ownerAnswersTheWaitingRequest(
	world: ChatticusWorld,
	choose: (request: OwnerFileRequest, answer: LiveFileOutcome) => LiveFileOutcome = (_request, answer) => answer,
) {
	await untilRequestIsWaiting(world);
	const owner = ownerOf(world);
	const scenario = memberFilesOf(world);
	const polled = await owner.poll();
	assert.equal(polled.status, 200, JSON.stringify(polled.body));
	const requests = owner.lastPoll?.file_requests ?? [];
	assert.ok(requests.length > 0, "The poll carried no file request for the owner to answer.");
	for (const request of requests) {
		const outcome = choose(request, scenario.disk.answer(request));
		const posted = await owner.postResult(request.operation_id, outcome);
		assert.equal(posted.status, 200, JSON.stringify(posted.body));
		scenario.lastAnswer = { operationId: request.operation_id, outcome };
	}
	return settleInFlight(world, 0);
}

function responseNumber(world: ChatticusWorld, ordinal: number) {
	const response = memberFilesOf(world).responses[ordinal - 1];
	assert.ok(response, `The scenario has no file response number ${ordinal}.`);
	return response;
}

function lastResponse(world: ChatticusWorld) {
	const response = fileRoutesOf(world).response;
	assert.ok(response, "No file route has been called in this scenario.");
	return response;
}

// ---------------------------------------------------------------- a running owner

Given("a live owner is polling for the household computer in state {string}", async function (this: ChatticusWorld, state: string) {
	const owner = await startLiveOwner(this);
	const answer = await owner.poll({ state: state as never });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Given("a live owner is polling for the household computer with protocol version {int}", async function (this: ChatticusWorld, version: number) {
	const owner = await startLiveOwner(this);
	const answer = await owner.poll({ protocolVersion: version });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Given("a live owner is polling for the household computer every {int} second(s)", async function (this: ChatticusWorld, seconds: number) {
	const owner = await startLiveOwner(this);
	assert.equal(owner.lastPoll?.next_poll_ms, seconds * 1000);
});

Given(
	"a live owner that polls every {int} seconds and last polled {int} second(s) ago",
	async function (this: ChatticusWorld, pollSeconds: number, agoSeconds: number) {
		const owner = await startLiveOwner(this);
		this.clock.advanceSeconds(SIX_HUNDRED_SECONDS);
		const answer = await owner.poll();
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.equal(owner.lastPoll?.next_poll_ms, pollSeconds * 1000);
		this.clock.advanceSeconds(agoSeconds);
	},
);

Given("the owner's stop request was approved", async function (this: ChatticusWorld) {
	assert.deepEqual(await ownerOf(this).requestStop("idle"), { approved: true });
});

Given("the overlay is sealed by that owner", async function (this: ChatticusWorld) {
	const answer = await ownerOf(this).sealOverlay();
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Given("{int} file requests are pending that the owner has not taken", async function (this: ChatticusWorld, count: number) {
	assert.equal(count, LIVE_FILE_MAX_OPEN_OPERATIONS);
	const computer = await computerForOrganization(TENANT, { store: this.messagingStore() });
	for (let number = 0; number < count; number += 1) {
		const queued = await queueLiveFileRequest(dependenciesOf(this), {
			computer,
			userId: "mia",
			operationId: newLiveFileOperationId(this.ids),
			request: { kind: "read", path: `/workspace/pending-${number}.md`, offset: 0, length: 4096, mask: true },
		});
		assert.equal(queued.status, "queued");
	}
});

// ---------------------------------------------------------------- the disk of the running owner

Given("the live disk of the owner holds workspace file {string} containing {string}", function (this: ChatticusWorld, relative: string, content: string) {
	memberFilesOf(this).disk.putFile(workspaceFile(relative), content);
});

Given("the live disk of the owner holds a binary file {string} of {int} bytes", function (this: ChatticusWorld, path: string, size: number) {
	memberFilesOf(this).disk.putFile(path, Buffer.alloc(size));
});

Given("the live disk of the owner holds a file {string} of {int} bytes", function (this: ChatticusWorld, path: string, size: number) {
	memberFilesOf(this).disk.putFile(path, "a".repeat(size));
});

Given("the live disk of the owner holds {int} files in {string}", function (this: ChatticusWorld, count: number, directory: string) {
	for (let number = 0; number < count; number += 1) memberFilesOf(this).disk.putFile(`${directory}/file-${String(number).padStart(5, "0")}.txt`, "x");
});

Given("the live disk of the owner holds a symbolic link {string} to {string}", function (this: ChatticusWorld, path: string, target: string) {
	memberFilesOf(this).disk.putSymlink(path, target);
});

Given("the bot writes {string} to the live file {string}", function (this: ChatticusWorld, content: string, path: string) {
	memberFilesOf(this).disk.putFile(path, content);
});

Then("the live disk of the owner now has workspace file {string} containing {string}", function (this: ChatticusWorld, relative: string, content: string) {
	assert.equal(memberFilesOf(this).disk.textOf(workspaceFile(relative)), content);
});

Then("the live file {string} still has {int} bytes", function (this: ChatticusWorld, path: string, size: number) {
	assert.equal(memberFilesOf(this).disk.sizeOf(path), size);
});

// ---------------------------------------------------------------- what the scenario assumes about the computer

Given("the computer has never published a snapshot", async function (this: ChatticusWorld) {
	const computer = await computerForOrganization(TENANT, { store: this.messagingStore() });
	assert.equal(computer.snapshotUri, undefined);
});

Given("the organization of tenant {string} is suspended", async function (this: ChatticusWorld, tenantId: string) {
	const store = this.messagingStore();
	const organization = await store.getOrganization(tenantId);
	assert.ok(organization, `There is no organization ${tenantId}.`);
	await store.putOrganization({ ...organization, status: "suspended" });
});

Given("tenant {string} has user {string}", async function (this: ChatticusWorld, tenantId: string, userId: string) {
	await ensureMember(this, tenantId, userId);
});

Given("the audit table cannot be written", function (this: ChatticusWorld) {
	const store = this.messagingStore();
	store.putFileAudit = async () => {
		throw new Error("the audit table is unavailable");
	};
});

Given("member {string} has created {int} files while the computer is off", async function (this: ChatticusWorld, userId: string, count: number) {
	const deps = overlayDependenciesOf(this);
	for (let number = 0; number < count; number += 1) {
		await changeOverlay(deps, {
			tenantId: TENANT,
			userId,
			request: { op: "put", path: `/workspace/created-${number}.md`, content: `file ${number}`, precondition: { type: "if_none_match" } },
		});
	}
});

Given("member {string} has read the computer file {string} and holds its hash", async function (this: ChatticusWorld, userId: string, path: string) {
	const scenario = memberFilesOf(this);
	const before = scenario.responses.length;
	const headers = await memberHeadersFor(this, TENANT, userId);
	let response = await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}`, headers });
	if (response === null) response = await ownerAnswersTheWaitingRequest(this);
	assert.equal(response.status, 200, response.text);
	scenario.heldHashes.set(`${userId} ${path}`, response.json.sha256);
	scenario.responses.length = before;
});

// ---------------------------------------------------------------- reading as a member

When("a member reads the computer file {string} and the owner does not answer for {int} seconds", async function (this: ChatticusWorld, path: string, seconds: number) {
	const headers = await memberHeadersFor(this, TENANT, "ryan");
	const response = await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}`, headers });
	assert.equal(response, null, "The read was answered without waiting for the owner.");
	await settleInFlight(this, 0.25);
	assert.ok(seconds >= 8, "The owner is only silent for the whole wait.");
});

When("a member reads the computer file {string} as the version {string}", async function (this: ChatticusWorld, path: string, variant: string) {
	const headers = await memberHeadersFor(this, TENANT, "ryan");
	await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}&variant=${variant}`, headers });
});

When("user {string} reads the computer file {string} of tenant {string}", async function (this: ChatticusWorld, userId: string, path: string, tenantId: string) {
	const headers = await bearerFor(this, `${userId}@other.test`);
	await sendFileRoute(this, { method: "GET", path: `/orgs/${tenantId}/computer/files/content?path=${encodeURIComponent(path)}`, headers });
});

When("a caller with no credential reads the computer file {string}", async function (this: ChatticusWorld, path: string) {
	await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}`, headers: {} });
});

When("the owner presents its supervisor token to read the computer file {string}", async function (this: ChatticusWorld, path: string) {
	const owner = ownerOf(this);
	await sendFileRoute(this, {
		method: "GET",
		path: `${FILES}/content?path=${encodeURIComponent(path)}`,
		headers: { Authorization: `Bearer ${owner.wire.token}` },
	});
});

function installStopBeforeQueueing(world: ChatticusWorld): void {
	const store = world.messagingStore();
	const queue = store.queueLiveFileOperation.bind(store);
	let injected = false;
	store.queueLiveFileOperation = async (...args: Parameters<typeof queue>) => {
		if (!injected) {
			injected = true;
			assert.deepEqual(await ownerOf(world).requestStop("idle"), { approved: true });
		}
		return queue(...args);
	};
}

When(
	"a member reads the computer file {string} while the owner's idle stop is approved between the request being judged and being queued",
	async function (this: ChatticusWorld, path: string) {
		installStopBeforeQueueing(this);
		const headers = await memberHeadersFor(this, TENANT, "ryan");
		const response = await sendFileRoute(this, { method: "GET", path: `${FILES}/content?path=${encodeURIComponent(path)}`, headers });
		assert.ok(response, "The read waited for an owner that had stopped.");
	},
);

// ---------------------------------------------------------------- the owner acts

When("the owner polls and answers the file request it is given", async function (this: ChatticusWorld) {
	await ownerAnswersTheWaitingRequest(this);
});

When("the owner polls and answers the file request with the error {string}", async function (this: ChatticusWorld, code: string) {
	await ownerAnswersTheWaitingRequest(this, () => ({ status: "error", code: code as never, message: "the scenario's owner refused" }));
});

When("the owner polls and answers the read with the content {string} and does not mask it", async function (this: ChatticusWorld, content: string) {
	await ownerAnswersTheWaitingRequest(this, (request) => {
		assert.equal(request.kind, "read");
		return {
			status: "ok",
			result: {
				kind: "read",
				resolved_path: request.path as `/workspace/${string}`,
				size: Buffer.byteLength(content),
				sha256: hashOf(content),
				mode: "600",
				modified_at: "2026-01-01T00:00:00.000Z",
				encoding: "utf8",
				binary: false,
				offset: 0,
				length: Buffer.byteLength(content),
				content,
				truncated: false,
				masked: false,
			},
		};
	});
});

When("the owner polls and answers the write reporting the hash of {string} as the new hash", async function (this: ChatticusWorld, text: string) {
	await ownerAnswersTheWaitingRequest(this, (_request, answer) => {
		assert.ok(answer.status === "ok" && answer.result.kind === "write", "The fake disk did not accept the write.");
		return { status: "ok", result: { ...answer.result, sha256_after: hashOf(text) } };
	});
});

When("the owner polls and holds the file request for {int} seconds", async function (this: ChatticusWorld, seconds: number) {
	const scenario = memberFilesOf(this);
	await untilRequestIsWaiting(this);
	const owner = ownerOf(this);
	const startedAt = this.clock.now().getTime();
	const polled = await owner.poll();
	assert.equal(polled.status, 200, JSON.stringify(polled.body));
	const [held] = owner.lastPoll?.file_requests ?? [];
	assert.ok(held, "The poll carried no file request to hold.");
	scenario.heldRequest = held;
	await settleInFlight(this, 0.25);
	const elapsed = (this.clock.now().getTime() - startedAt) / 1000;
	if (elapsed < seconds) this.clock.advanceSeconds(seconds - elapsed);
});

When("the owner posts the result of the request it held", async function (this: ChatticusWorld) {
	const scenario = memberFilesOf(this);
	assert.ok(scenario.heldRequest, "The owner holds no request.");
	const posted = await ownerOf(this).postResult(scenario.heldRequest.operation_id, scenario.disk.answer(scenario.heldRequest));
	assert.equal(posted.status, 200, JSON.stringify(posted.body));
});

When("the owner answers the request that was abandoned", async function (this: ChatticusWorld) {
	const operations = await this.messagingStore().listLiveFileOperations(TENANT, this.clock.now());
	const abandoned = operations.find((operation) => operation.status === "abandoned");
	assert.ok(abandoned, "No request was abandoned.");
	memberFilesOf(this).lastOwnerReply = await ownerOf(this).postResult(abandoned.operationId, memberFilesOf(this).disk.answer({
		operation_id: abandoned.operationId,
		kind: "read",
		path: "/workspace/notes.md",
		offset: 0,
		length: 4096,
		mask: true,
		expires_in_ms: 0,
	}));
});

When("the owner posts the answer it gave again", async function (this: ChatticusWorld) {
	const scenario = memberFilesOf(this);
	assert.ok(scenario.lastAnswer, "The owner gave no answer yet.");
	scenario.lastOwnerReply = await ownerOf(this).postResult(scenario.lastAnswer.operationId, scenario.lastAnswer.outcome);
});

Then("the owner's answer is refused with code {string}", function (this: ChatticusWorld, code: string) {
	const reply = memberFilesOf(this).lastOwnerReply;
	assert.ok(reply, "The owner posted no answer.");
	assert.equal(reply.status, 409, JSON.stringify(reply.body));
	assert.equal(reply.body.code, code);
});

// ---------------------------------------------------------------- writing as a member

When(
	"member {string} replaces the computer file {string} with {string} if it still has the hash of {string}",
	async function (this: ChatticusWorld, userId: string, path: string, content: string, expectedText: string) {
		await putContent(this, userId, TENANT, path, content, ifMatch(expectedText));
	},
);

When(
	"member {string} replaces the computer file {string} with {string} if it still has the hash of {string} and the owner does not answer for {int} seconds",
	async function (this: ChatticusWorld, userId: string, path: string, content: string, expectedText: string, seconds: number) {
		await putContent(this, userId, TENANT, path, content, ifMatch(expectedText));
		await settleInFlight(this, 0.25);
		assert.ok(seconds >= 8);
	},
);

When(
	"member {string} replaces the computer file {string} with {string} and sends no precondition",
	async function (this: ChatticusWorld, userId: string, path: string, content: string) {
		await putContent(this, userId, TENANT, path, content, {});
	},
);

When(
	"member {string} replaces the computer file {string} with {string} sending both preconditions",
	async function (this: ChatticusWorld, userId: string, path: string, content: string) {
		await putContent(this, userId, TENANT, path, content, { ...ifMatch("anything"), ...ifNoneMatch });
	},
);

When(
	/^member "([^"]*)" replaces the computer file "([^"]*)" with "([^"]*)" sending the header "([^"]*)" as (.*)$/,
	async function (this: ChatticusWorld, userId: string, path: string, content: string, header: string, value: string) {
		await putContent(this, userId, TENANT, path, content, { [header]: value });
	},
);

When(
	"member {string} replaces the computer file {string} with {int} bytes if it still has the hash of {string}",
	async function (this: ChatticusWorld, userId: string, path: string, size: number, expectedText: string) {
		await putContent(this, userId, TENANT, path, "a".repeat(size), ifMatch(expectedText));
	},
);

When(
	"member {string} replaces the computer file {string} with {string} if it still has the hash of that file",
	async function (this: ChatticusWorld, userId: string, path: string, content: string) {
		const held = memberFilesOf(this).disk.textOf(path);
		assert.ok(held !== null, `The live disk has no ${path}.`);
		await putContent(this, userId, TENANT, path, content, ifMatch(held));
	},
);

When(
	"user {string} replaces the computer file {string} of tenant {string} with {string} if it still has the hash of {string}",
	async function (this: ChatticusWorld, userId: string, path: string, tenantId: string, content: string, expectedText: string) {
		const headers = await bearerFor(this, `${userId}@other.test`);
		await sendFileRoute(this, {
			method: "PUT",
			path: `/orgs/${tenantId}/computer/files/content?path=${encodeURIComponent(path)}`,
			headers: putHeaders(headers, ifMatch(expectedText)),
			body: { content },
		});
	},
);

When("member {string} creates the computer file {string} with {string}", async function (this: ChatticusWorld, userId: string, path: string, content: string) {
	await putContent(this, userId, TENANT, path, content, ifNoneMatch);
});

When(
	"member {string} creates the computer file {string} while the owner's idle stop is approved between the request being judged and being queued",
	async function (this: ChatticusWorld, userId: string, path: string, ..._rest: unknown[]) {
		installStopBeforeQueueing(this);
		await putContent(this, userId, TENANT, path, "new", ifNoneMatch);
		assert.equal(memberFilesOf(this).pending, null, "The write waited for an owner that had stopped.");
	},
);

When(
	"member {string} and member {string} replace {string} and {string} at the same instant",
	async function (this: ChatticusWorld, first: string, second: string, firstPath: string, secondPath: string) {
		const scenario = memberFilesOf(this);
		const api = this.api;
		assert.ok(api, "The scenario has no HTTP front door.");
		const sendAs = async (userId: string, path: string, content: string, expected: string) => {
			const headers = putHeaders(await memberHeadersFor(this, TENANT, userId), ifMatch(expected));
			return readRouteResponse(await api.put(`${FILES}/content?path=${encodeURIComponent(path)}`, { headers, body: { content } }));
		};
		const responses = await Promise.all([
			sendAs(first, firstPath, `${first} was here`, "a"),
			sendAs(second, secondPath, `${second} was here`, "b"),
		]);
		scenario.responses.push(...responses);
		fileRoutesOf(this).response = responses[1]!;
	},
);

When("member {string} makes {int} write requests within one minute", async function (this: ChatticusWorld, userId: string, count: number) {
	for (let number = 1; number <= count; number += 1) await putContent(this, userId, TENANT, `/workspace/rate-${number}.md`, "x", {});
});

When("member {string} reveals the computer file {string}", async function (this: ChatticusWorld, userId: string, path: string) {
	const headers = await memberHeadersFor(this, TENANT, userId);
	await sendFileRoute(this, { method: "POST", path: `${FILES}/reveal`, headers, body: { path } });
});

When("member {string} reveals the computer file {string} {int} times within one minute", async function (this: ChatticusWorld, userId: string, path: string, count: number) {
	const headers = await memberHeadersFor(this, TENANT, userId);
	for (let number = 1; number <= count; number += 1) await sendFileRoute(this, { method: "POST", path: `${FILES}/reveal`, headers, body: { path } });
});

When("a member's Files panel pings that it is open through the watch route", async function (this: ChatticusWorld) {
	const headers = await memberHeadersFor(this, TENANT, "mia");
	await sendFileRoute(this, { method: "POST", path: `${FILES}/watch`, headers, body: { open: true } });
});

// ---------------------------------------------------------------- what the member was told

Then("the file response says {string} is the hash of {string}", function (this: ChatticusWorld, field: string, text: string) {
	assert.equal(lastResponse(this).json?.[field], hashOf(text), lastResponse(this).text);
});

Then("the file response carries the ETag of {string}", function (this: ChatticusWorld, text: string) {
	assert.equal(lastResponse(this).headers.get("ETag"), `"${hashOf(text)}"`);
});

Then("the file response carries no file content", function (this: ChatticusWorld) {
	const response = lastResponse(this);
	assert.ok(response.json?.content === undefined || response.json.content === "", response.text);
});

Then("the file response is answered at once from the saved copy", function (this: ChatticusWorld) {
	const response = lastResponse(this);
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json?.source, "snapshot");
	assert.equal(memberFilesOf(this).sleepsOfLastRequest, 0, "The request waited for the owner.");
});

Then("the file response has a modification time", function (this: ChatticusWorld) {
	const modified = lastResponse(this).json?.modified_at;
	assert.equal(typeof modified, "string", lastResponse(this).text);
	assert.ok(!Number.isNaN(Date.parse(modified)));
});

Then("the stat entry has a modification time", function (this: ChatticusWorld) {
	const modified = lastResponse(this).json?.entry?.modified_at;
	assert.equal(typeof modified, "string", lastResponse(this).text);
	assert.ok(!Number.isNaN(Date.parse(modified)));
});

Then("the listing shows {string} as a file of {int} bytes", function (this: ChatticusWorld, name: string, size: number) {
	const entry = (lastResponse(this).json?.entries ?? []).find((candidate: { name: string }) => candidate.name === name);
	assert.ok(entry, lastResponse(this).text);
	assert.equal(entry.kind, "file");
	assert.equal(entry.size, size);
});

Then("both pieces name the same SHA-256", function (this: ChatticusWorld) {
	const [first, second] = memberFilesOf(this).responses;
	assert.ok(first && second, "The scenario read fewer than two pieces.");
	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	assert.equal(first.json.sha256, second.json.sha256);
	assert.notEqual(first.json.content, second.json.content);
});

Then("the first file response status is {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(responseNumber(this, 1).status, status, responseNumber(this, 1).text);
});

Then("the second file response status is {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(responseNumber(this, 2).status, status, responseNumber(this, 2).text);
});

Then("the second file response says {string} is the hash of {string}", function (this: ChatticusWorld, field: string, text: string) {
	assert.equal(responseNumber(this, 2).json?.[field], hashOf(text));
});

Then("both file responses have status {int}", function (this: ChatticusWorld, status: number) {
	const responses = memberFilesOf(this).responses;
	assert.equal(responses.length, 2);
	for (const response of responses) assert.equal(response.status, status, response.text);
});

Then(/^the (\d+)(?:st|nd|rd|th) file response status is (\d+)$/, function (this: ChatticusWorld, ordinal: string, status: string) {
	assert.equal(responseNumber(this, Number(ordinal)).status, Number(status), responseNumber(this, Number(ordinal)).text);
});

Then(/^the (\d+)(?:st|nd|rd|th) file response carries a "([^"]*)" header$/, function (this: ChatticusWorld, ordinal: string, header: string) {
	const value = responseNumber(this, Number(ordinal)).headers.get(header);
	assert.ok(value !== null && /^\d+$/.test(value), `The ${header} header is ${value}.`);
	assert.ok(Number(value) >= 1);
});

// ---------------------------------------------------------------- the table

Then("the computer record says the disk is dirty", async function (this: ChatticusWorld) {
	assert.equal((await computerForOrganization(TENANT, { store: this.messagingStore() })).diskDirty, true);
});

Then("the file request was abandoned and its payload removed", async function (this: ChatticusWorld) {
	const operations = await this.messagingStore().listLiveFileOperations(TENANT, this.clock.now());
	assert.equal(operations.length, 1, JSON.stringify(operations));
	assert.equal(operations[0]!.status, "abandoned");
	assert.equal(operations[0]!.request, undefined);
	assert.equal(operations[0]!.outcome, undefined);
});

Then("no file operation record of the organization holds {string}", async function (this: ChatticusWorld, text: string) {
	const operations = await this.messagingStore().listLiveFileOperations(TENANT, this.clock.now());
	assert.ok(!JSON.stringify(operations).includes(text), "A file operation record still holds the text.");
});

Then("the computer record is unchanged", async function (this: ChatticusWorld) {
	const before = fileRoutesOf(this).computerRecordAfterPublish;
	assert.ok(before, "The computer was never published, so there is no record to compare.");
	assert.equal(JSON.stringify(await computerForOrganization(TENANT, { store: this.messagingStore() })), before);
});

Then("the saved snapshot pack was not changed", async function (this: ChatticusWorld) {
	const scenario = fileRoutesOf(this);
	assert.ok(scenario.manifest && scenario.publisherStore && scenario.bucket, "Nothing was published.");
	const computer = await computerForOrganization(TENANT, { store: this.messagingStore() });
	const manifest = await scenario.publisherStore.getManifest(snapshotUri(TENANT, computer.computerId, { bucket: scenario.bucket }));
	assert.equal(manifest.checksum, scenario.manifest.checksum);
	const writes = scenario.readerRequests.filter((request) => request.action !== "s3:GetObject");
	assert.deepEqual(writes, [], "The file routes wrote to the snapshot bucket.");
});

// ---------------------------------------------------------------- the audit log

async function auditRecordsOfAll(world: ChatticusWorld) {
	return world.messagingStore().listFileAuditRecords(TENANT, world.clock.now());
}

Then("the audit log has no records", async function (this: ChatticusWorld) {
	assert.deepEqual(await auditRecordsOfAll(this), []);
});

Then(
	"the audit log has a record for member {string} with outcome {string} and error {string}",
	async function (this: ChatticusWorld, userId: string, outcome: string, error: string) {
		const records = (await auditRecordsOf(this, userId)).filter((record) => record.outcome === outcome && record.errorCode === error);
		assert.equal(records.length, 1, JSON.stringify(await auditRecordsOfAll(this)));
	},
);

Then("the audit log has a record for member {string} with outcome {string}", async function (this: ChatticusWorld, userId: string, outcome: string) {
	const records = (await auditRecordsOf(this, userId)).filter((record) => record.outcome === outcome);
	assert.equal(records.length, 1, JSON.stringify(await auditRecordsOfAll(this)));
});

const AUDIT_FIELDS: Record<string, string> = {
	operation: "operation",
	path: "path",
	to_path: "toPath",
	outcome: "outcome",
	source: "source",
	sha256_before: "sha256Before",
	sha256_after: "sha256After",
	bytes: "bytes",
	revealed: "revealed",
};

function auditFieldsDiffer(record: unknown, table: DataTable): string | null {
	const fields = record as Record<string, unknown>;
	for (const row of table.hashes() as Array<{ field: string; value: string }>) {
		const name = AUDIT_FIELDS[row.field];
		assert.ok(name, `Unknown audit field ${row.field}.`);
		const actual = name === "revealed" ? String(fields[name] === true) : String(fields[name]);
		if (actual !== resolveValue(row.value)) return `${row.field} is ${actual}, not ${resolveValue(row.value)}`;
	}
	return null;
}

Then("the audit log has one record for member {string} with these fields:", async function (this: ChatticusWorld, userId: string, table: DataTable) {
	const records = await auditRecordsOf(this, userId);
	assert.equal(records.length, 1, `The audit log holds ${records.length} records for ${userId}: ${JSON.stringify(await auditRecordsOfAll(this))}`);
	assert.equal(auditFieldsDiffer(records[0], table), null);
});

Then("the audit log has a record for member {string} with these fields:", async function (this: ChatticusWorld, userId: string, table: DataTable) {
	const records = await auditRecordsOf(this, userId);
	assert.ok(records.some((record) => auditFieldsDiffer(record, table) === null), `No record of ${userId} matches: ${JSON.stringify(records)}`);
});

Then("the audit record holds no file content", async function (this: ChatticusWorld) {
	const serialized = JSON.stringify(await auditRecordsOfAll(this));
	for (const content of ["second draft", "first draft", "API_KEY=abc123", "API_KEY=def456"]) assert.ok(!serialized.includes(content), `The audit holds ${content}.`);
});

Then("the audit record expires in {int} days", async function (this: ChatticusWorld, days: number) {
	assert.equal(days, LIVE_FILE_AUDIT_RETENTION_DAYS);
	const [record] = await auditRecordsOfAll(this);
	assert.ok(record);
	assert.equal(record.expiresAt.getTime() - record.at.getTime(), days * 24 * 3600 * 1000);
});
