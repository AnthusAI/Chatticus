import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { LiveFileOutcome, OwnerFileRequest } from "@chatticus/host-protocol/live-files";
import { OWNER_COMPUTER_ROUTES } from "../../src/http/owner-host-auth.ts";
import { OWNER_ERROR_STATUS, ownerErrorCodeSchema, type OwnerStopResponse } from "@chatticus/host-protocol/supervisor";
import { ownerFileResultResponseSchema } from "@chatticus/host-protocol/live-files";
import { computerForOrganization } from "../../src/domain/computers.ts";
import {
	newLiveFileOperationId,
	queueLiveFileRequest,
	watchFilePanel,
	type FilePanelWatchResult,
	type LiveFileDependencies,
	type LiveFileRequestBody,
	type QueueLiveFileRequestResult,
} from "../../src/domain/live-files.ts";
import { policyAllows, supervisorRolePolicyStatements } from "../iam-policy-evaluator.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { FakeLiveOwner } from "../fakes/fake-live-owner.ts";
import { FIXED_STORE_NAMES, ownerRoleFor } from "../owner-role-support.ts";
import { tableArnOf } from "../aws-request-recorder.ts";
import type { ChatticusWorld } from "../world.ts";
import { bootstrapOwner, ownerServerOf } from "./owner-supervisor-server.steps.ts";

type Answer = { readonly status: number; readonly body: any };

type LiveFilesScenario = {
	owner: FakeLiveOwner | null;
	userId: string;
	operationId: string | null;
	auditAtMilliseconds: number | null;
	queueResult: QueueLiveFileRequestResult | null;
	lastResult: Answer | null;
	lastResultBody: { operationId: string; outcome: LiveFileOutcome } | null;
	operationBeforeLastPost: string | null;
	firstDeliveredOperationId: string | null;
	watch: FilePanelWatchResult | null;
	stop: OwnerStopResponse | null;
	writeContent: string;
};

const scenarios = new WeakMap<ChatticusWorld, LiveFilesScenario>();

function scenarioOf(world: ChatticusWorld): LiveFilesScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			owner: null,
			userId: "",
			operationId: null,
			auditAtMilliseconds: null,
			queueResult: null,
			lastResult: null,
			lastResultBody: null,
			operationBeforeLastPost: null,
			firstDeliveredOperationId: null,
			watch: null,
			stop: null,
			writeContent: "",
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

function ownerOf(world: ChatticusWorld): FakeLiveOwner {
	const owner = scenarioOf(world).owner;
	assert.ok(owner, "The scenario has no live owner.");
	return owner;
}

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

function dependenciesOf(world: ChatticusWorld): LiveFileDependencies {
	return { store: world.messagingStore(), clock: world.clock, ids: world.ids, heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds };
}

function ownerWireOf(world: ChatticusWorld) {
	assert.ok(world.app, "The scenario has no HTTP front door.");
	const server = ownerServerOf(world);
	return { app: world.app, tenantId: STORY_TENANT, ownerId: server.ownerId, generation: server.generation, token: server.supervisorToken };
}

async function startLiveOwner(world: ChatticusWorld): Promise<FakeLiveOwner> {
	await bootstrapOwner(world);
	const owner = new FakeLiveOwner(ownerWireOf(world));
	const answer = await owner.poll();
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	scenarioOf(world).owner = owner;
	return owner;
}

const readRequest: LiveFileRequestBody = { kind: "read", path: "/workspace/notes.md", offset: 0, length: 4096, mask: true };

const readOutcome = (content: string): LiveFileOutcome => ({
	status: "ok",
	result: {
		kind: "read",
		resolved_path: "/workspace/notes.md",
		size: Buffer.byteLength(content),
		sha256: sha256Of(content),
		mode: "644",
		modified_at: "2026-01-01T00:00:00.000Z",
		encoding: "utf8",
		binary: false,
		offset: 0,
		length: Buffer.byteLength(content),
		content,
		truncated: false,
		masked: false,
	},
});

const writeOutcome = (path: string, content: string, reportedNewHash: string = sha256Of(content)): LiveFileOutcome => ({
	status: "ok",
	result: {
		kind: "write",
		resolved_path: path as `/workspace/${string}`,
		created: false,
		size: Buffer.byteLength(content),
		sha256_before: sha256Of("first draft"),
		sha256_after: reportedNewHash,
		modified_at: "2026-01-01T00:00:00.000Z",
	},
});

async function queueRead(world: ChatticusWorld, userId: string): Promise<void> {
	const scenario = scenarioOf(world);
	const computer = await computerForOrganization(STORY_TENANT, { store: world.messagingStore() });
	const result = await queueLiveFileRequest(dependenciesOf(world), { computer, userId, request: readRequest });
	assert.equal(result.status, "queued", "The request was not queued.");
	scenario.queueResult = result;
	scenario.userId = userId;
	scenario.operationId = result.status === "queued" ? result.operationId : null;
}

function operationIdOf(world: ChatticusWorld): string {
	const id = scenarioOf(world).operationId;
	assert.ok(id, "The scenario queued no file request.");
	return id;
}

async function operationJson(world: ChatticusWorld, operationId: string): Promise<string | null> {
	return JSON.stringify(await world.messagingStore().getLiveFileOperation(STORY_TENANT, operationId, world.clock.now()));
}

async function post(world: ChatticusWorld, operationId: string, outcome: LiveFileOutcome, owner: FakeLiveOwner = ownerOf(world)): Promise<void> {
	const scenario = scenarioOf(world);
	scenario.operationBeforeLastPost = await operationJson(world, operationId);
	scenario.lastResultBody = { operationId, outcome };
	scenario.lastResult = await owner.postResult(operationId, outcome);
}

async function auditRecordsOf(world: ChatticusWorld, userId: string) {
	const now = world.clock.now();
	const records = await world.messagingStore().listFileAuditRecords(STORY_TENANT, now);
	return records.filter((record) => record.userId === userId);
}

Given("a live owner is polling for the household computer", async function (this: ChatticusWorld) {
	await startLiveOwner(this);
});

Given("no owner is running", async function (this: ChatticusWorld) {
	const computer = await computerForOrganization(STORY_TENANT, { store: this.messagingStore() });
	assert.equal(computer.ownerId, undefined);
});

Given(
	"a live owner that has been idle for {int} minutes and polls every {int} seconds",
	async function (this: ChatticusWorld, minutes: number, seconds: number) {
		const owner = await startLiveOwner(this);
		this.clock.advanceSeconds(minutes * 60);
		const answer = await owner.poll();
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.equal(owner.lastPoll?.next_poll_ms, seconds * 1000);
	},
);

Given("a live owner that has been idle for {int} minutes", async function (this: ChatticusWorld, minutes: number) {
	const owner = await startLiveOwner(this);
	this.clock.advanceSeconds(minutes * 60);
	const answer = await owner.poll();
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Given("a live owner that is serving a turn and polls every {int} seconds", async function (this: ChatticusWorld, seconds: number) {
	const owner = await startLiveOwner(this);
	const answer = await owner.poll({ state: "serving" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(owner.lastPoll?.next_poll_ms, seconds * 1000);
});

Given("member {string} has a file request pending that the owner has not taken", async function (this: ChatticusWorld, userId: string) {
	await queueRead(this, userId);
});

Given(
	"member {string} has a write of {string} to {string} pending that the owner has not taken, with its audit record",
	async function (this: ChatticusWorld, userId: string, content: string, path: string) {
		const scenario = scenarioOf(this);
		const store = this.messagingStore();
		const computer = await computerForOrganization(STORY_TENANT, { store });
		const operationId = newLiveFileOperationId(this.ids);
		const at = this.clock.now();
		await store.putFileAudit({
			tenantId: STORY_TENANT,
			computerId: computer.computerId,
			userId,
			operationId,
			operation: "write",
			path,
			source: "live",
			outcome: "pending",
			at,
			expiresAt: new Date(at.getTime() + 90 * 24 * 3600 * 1000),
			sha256Before: sha256Of("first draft"),
			sha256After: sha256Of(content),
			bytes: Buffer.byteLength(content),
			secretName: false,
		});
		const result = await queueLiveFileRequest(dependenciesOf(this), {
			computer,
			userId,
			operationId,
			auditAtMilliseconds: at.getTime(),
			request: { kind: "write", path: path as `/workspace/${string}`, content, precondition: { type: "if_match", sha256: sha256Of("first draft") } },
		});
		assert.equal(result.status, "queued");
		scenario.queueResult = result;
		scenario.userId = userId;
		scenario.operationId = operationId;
		scenario.auditAtMilliseconds = at.getTime();
		scenario.writeContent = content;
	},
);

When("the owner polls", async function (this: ChatticusWorld) {
	const answer = await ownerOf(this).poll();
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("the owner polls with the next sequence number", async function (this: ChatticusWorld) {
	const answer = await ownerOf(this).poll();
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("the owner repeats the poll it did not hear back", async function (this: ChatticusWorld) {
	const answer = await ownerOf(this).poll({ repeat: true });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("the owner polls reporting state {string}", async function (this: ChatticusWorld, state: string) {
	const answer = await ownerOf(this).poll({ state: state as never });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("the owner polls speaking protocol version {int}", async function (this: ChatticusWorld, version: number) {
	const answer = await ownerOf(this).poll({ protocolVersion: version });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("{int} seconds pass at the control plane", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

Then("the poll response carries one file request", function (this: ChatticusWorld) {
	const requests = ownerOf(this).lastPoll?.file_requests ?? [];
	assert.equal(requests.length, 1, `The poll carried ${requests.length} file requests.`);
	assert.equal(requests[0]!.operation_id, operationIdOf(this));
	const scenario = scenarioOf(this);
	scenario.firstDeliveredOperationId ??= requests[0]!.operation_id;
});

Then("the poll response carries one file request that expires in {int} milliseconds", function (this: ChatticusWorld, milliseconds: number) {
	const requests = ownerOf(this).lastPoll?.file_requests ?? [];
	assert.equal(requests.length, 1, `The poll carried ${requests.length} file requests.`);
	assert.equal(requests[0]!.expires_in_ms, milliseconds);
});

Then("the poll response carries the same file request", function (this: ChatticusWorld) {
	const requests: OwnerFileRequest[] = ownerOf(this).lastPoll?.file_requests ?? [];
	assert.equal(requests.length, 1, `The poll carried ${requests.length} file requests.`);
	assert.equal(requests[0]!.operation_id, scenarioOf(this).firstDeliveredOperationId);
});

Then("the poll response carries no file request", function (this: ChatticusWorld) {
	assert.deepEqual(ownerOf(this).lastPoll?.file_requests, []);
});

When("another owner of the same organization posts a result for that operation", async function (this: ChatticusWorld) {
	const operationId = operationIdOf(this);
	this.clock.advanceSeconds(61);
	await bootstrapOwner(this);
	const second = new FakeLiveOwner(ownerWireOf(this));
	const polled = await second.poll();
	assert.equal(polled.status, 200, JSON.stringify(polled.body));
	await post(this, operationId, readOutcome("hello"), second);
});

When("the Front Door abandons the request that member {string} is waiting for", async function (this: ChatticusWorld, _userId: string) {
	const status = await this.messagingStore().abandonLiveFileOperation(STORY_TENANT, operationIdOf(this), this.clock.now());
	assert.equal(status, "abandoned");
});

When("the Front Door stops waiting for the write the owner took", async function (this: ChatticusWorld) {
	assert.equal(await this.messagingStore().markLiveFileOperationWaiterGone(STORY_TENANT, operationIdOf(this)), true);
});

When("the owner posts a result for that operation", async function (this: ChatticusWorld) {
	await post(this, operationIdOf(this), readOutcome("hello"));
});

When("the owner posts the same result again", async function (this: ChatticusWorld) {
	const last = scenarioOf(this).lastResultBody;
	assert.ok(last, "The owner posted no result yet.");
	await post(this, last.operationId, last.outcome);
});

When("the owner posts a different result for that operation", async function (this: ChatticusWorld) {
	await post(this, operationIdOf(this), readOutcome("something else entirely"));
});

When("the owner posts a result that claims a read answered a write", async function (this: ChatticusWorld) {
	await post(this, operationIdOf(this), writeOutcome("/workspace/notes.md", "second draft"));
});

When("the owner answers the write it was given", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await post(this, operationIdOf(this), writeOutcome("/workspace/notes.md", scenario.writeContent));
});

When("the owner answers the write reporting the hash of {string} as the new hash", async function (this: ChatticusWorld, text: string) {
	const scenario = scenarioOf(this);
	await post(this, operationIdOf(this), writeOutcome("/workspace/notes.md", scenario.writeContent, sha256Of(text)));
});

When("the owner answers the write with the error {string}", async function (this: ChatticusWorld, code: string) {
	await post(this, operationIdOf(this), {
		status: "error",
		code: code as never,
		message: "the scenario's owner refused",
		current_sha256: sha256Of("someone else's text"),
	});
});

Then("the result is refused with code {string}", function (this: ChatticusWorld, code: string) {
	const answer = scenarioOf(this).lastResult;
	assert.ok(answer, "The owner posted no result.");
	const known = ownerErrorCodeSchema.parse(code);
	assert.equal(answer.status, OWNER_ERROR_STATUS[known], JSON.stringify(answer.body));
	assert.equal(answer.body.code, code);
});

Then("the result is acknowledged", function (this: ChatticusWorld) {
	const answer = scenarioOf(this).lastResult;
	assert.ok(answer, "The owner posted no result.");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(ownerFileResultResponseSchema.parse(answer.body), { recorded: true });
});

Then("the result is acknowledged and nothing changes", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const answer = scenario.lastResult;
	assert.ok(answer, "The owner posted no result.");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(ownerFileResultResponseSchema.parse(answer.body), { recorded: true });
	assert.equal(await operationJson(this, scenario.lastResultBody!.operationId), scenario.operationBeforeLastPost);
});

Then("no file request is left in the table", async function (this: ChatticusWorld) {
	assert.deepEqual(await this.messagingStore().listLiveFileOperations(STORY_TENANT, this.clock.now()), []);
});

Then("no file request was left for the owner", async function (this: ChatticusWorld) {
	assert.deepEqual(await this.messagingStore().listLiveFileOperations(STORY_TENANT, this.clock.now()), []);
});

Then("the audit log has one record for member {string} with outcome {string}", async function (this: ChatticusWorld, userId: string, outcome: string) {
	const records = await auditRecordsOf(this, userId);
	assert.equal(records.length, 1, `The audit log holds ${records.length} records for ${userId}.`);
	assert.equal(records[0]!.outcome, outcome);
});

Then("the audit log has one record for member {string} with the flag {string}", async function (this: ChatticusWorld, userId: string, flag: string) {
	const records = await auditRecordsOf(this, userId);
	assert.equal(records.length, 1, `The audit log holds ${records.length} records for ${userId}.`);
	assert.deepEqual(records[0]!.flags, [flag]);
});

Then("the audit record names the resolved path {string}", async function (this: ChatticusWorld, path: string) {
	const records = await auditRecordsOf(this, scenarioOf(this).userId);
	assert.equal(records[0]?.resolvedPath, path);
});

Then("the audit record carries no flag", async function (this: ChatticusWorld) {
	const records = await auditRecordsOf(this, scenarioOf(this).userId);
	assert.equal(records[0]?.flags, undefined);
});

Then("the audit record carries the error code {string}", async function (this: ChatticusWorld, code: string) {
	const records = await auditRecordsOf(this, scenarioOf(this).userId);
	assert.equal(records[0]?.errorCode, code);
});

When("a member's Files panel tells the computer it is open", async function (this: ChatticusWorld) {
	scenarioOf(this).watch = await watchFilePanel(dependenciesOf(this), STORY_TENANT, true);
});

Given("a member's Files panel told the computer it is open", async function (this: ChatticusWorld) {
	scenarioOf(this).watch = await watchFilePanel(dependenciesOf(this), STORY_TENANT, true);
});

Given("a member's Files panel told the computer it is open {int} seconds ago", async function (this: ChatticusWorld, seconds: number) {
	scenarioOf(this).watch = await watchFilePanel(dependenciesOf(this), STORY_TENANT, true);
	this.clock.advanceSeconds(seconds);
});

When("the panel tells the computer it is closed", async function (this: ChatticusWorld) {
	scenarioOf(this).watch = await watchFilePanel(dependenciesOf(this), STORY_TENANT, false);
});

When("{int} seconds go by without another message from the panel", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

Then("the response says the computer is live", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).watch?.state, "live");
});

Then("the response says the computer is off", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).watch?.state, "off");
});

Then("the next poll of the owner is answered with a pace of {int} second(s)", async function (this: ChatticusWorld, seconds: number) {
	const owner = ownerOf(this);
	const answer = await owner.poll();
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(owner.lastPoll?.next_poll_ms, seconds * 1000);
});

When("the owner asks to stop because it has been idle", async function (this: ChatticusWorld) {
	scenarioOf(this).stop = await ownerOf(this).requestStop("idle");
});

Then("the stop is approved", function (this: ChatticusWorld) {
	assert.deepEqual(scenarioOf(this).stop, { approved: true });
});

Then("the stop is vetoed with reason {string}", function (this: ChatticusWorld, reason: string) {
	assert.deepEqual(scenarioOf(this).stop, { approved: false, reason });
});

When("the owner's idle stop is approved between a member's request being judged and being queued", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const judged = await computerForOrganization(STORY_TENANT, { store: this.messagingStore() });
	scenario.stop = await ownerOf(this).requestStop("idle");
	assert.deepEqual(scenario.stop, { approved: true });
	scenario.queueResult = await queueLiveFileRequest(dependenciesOf(this), { computer: judged, userId: "mia", request: readRequest });
});

Then("the member's file request is not queued", async function (this: ChatticusWorld) {
	assert.deepEqual(await this.messagingStore().listLiveFileOperations(STORY_TENANT, this.clock.now()), []);
});

Then("queueing it was refused because the owner is stopping", function (this: ChatticusWorld) {
	assert.deepEqual(scenarioOf(this).queueResult, { status: "owner_stopping" });
});

When(
	"a member's request is queued between the owner's idle stop being judged and being approved",
	async function (this: ChatticusWorld) {
		const scenario = scenarioOf(this);
		const store = this.messagingStore();
		const approve = store.approveOwnerStop.bind(store);
		let injected = false;
		store.approveOwnerStop = async (...args: Parameters<typeof approve>) => {
			if (!injected) {
				injected = true;
				await queueRead(this, "mia");
			}
			return approve(...args);
		};
		scenario.stop = await ownerOf(this).requestStop("idle");
		assert.equal(injected, true, "The stop was never approved or vetoed through the store.");
	},
);

const DYNAMODB_ACTIONS = [
	"dynamodb:GetItem",
	"dynamodb:BatchGetItem",
	"dynamodb:Query",
	"dynamodb:Scan",
	"dynamodb:PutItem",
	"dynamodb:UpdateItem",
	"dynamodb:DeleteItem",
	"dynamodb:BatchWriteItem",
	"dynamodb:TransactWriteItems",
	"dynamodb:TransactGetItems",
];

Then("the per-turn role policy denies every DynamoDB action on the key family {string}", function (this: ChatticusWorld, family: string) {
	const role = ownerRoleFor({ tenantId: STORY_TENANT, botId: "bot-1", channelId: "channel-1", computerId: "household-computer", turnId: "turn-1" });
	for (const action of DYNAMODB_ACTIONS) {
		const request = {
			action,
			resourceArn: tableArnOf(FIXED_STORE_NAMES.messagingTable),
			contextKeys: { "dynamodb:LeadingKeys": [family] },
		};
		assert.equal(policyAllows(role.statements, role.tags, request), false, `${action} is allowed on ${family}`);
	}
});

Then("the supervisor role policy denies every DynamoDB action", function (this: ChatticusWorld) {
	const statements = supervisorRolePolicyStatements({ snapshotBucketArn: "arn:aws:s3:::snapshots" });
	for (const statement of statements) {
		for (const action of statement.Action) assert.equal(action.startsWith("dynamodb:") || action === "*", false, `${statement.Sid ?? "statement"} names ${action}`);
	}
});

Then("no owner route returns an audit record", async function (this: ChatticusWorld) {
	for (const route of OWNER_COMPUTER_ROUTES) {
		assert.equal(/audit|fileops/.test(route.suffix), false, `${route.suffix} names the audit family`);
	}
	assert.deepEqual(Object.keys(ownerFileResultResponseSchema.shape), ["recorded"]);
});
