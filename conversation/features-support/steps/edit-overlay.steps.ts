import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS, OWNER_PROTOCOL_VERSION } from "@chatticus/host-protocol/supervisor";
import { EditOverlayRefusal, changeOverlay, loadEffectiveOverlayView } from "../../src/domain/edit-overlay.ts";
import { ensureComputer, requestComputerHostStart } from "../../src/domain/computers.ts";
import { registerWorker } from "../../src/domain/workers.ts";
import { mintOwnerBootstrapToken } from "../../src/gateway/session-token.ts";
import { wireFrontDoor } from "../front-door.ts";
import { createFileRoutesBucket } from "../computer-snapshot-files-support.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import { STORY_TENANT, STORY_USER } from "../computer-scenario.ts";
import { ensureMember, memberHeadersFor } from "../turn-grant-support.ts";
import {
	COMPUTER_ID,
	TENANT,
	createOverlayScenario,
	hashOfText,
	overlayDependenciesOf,
	overlayScenarioOf,
	resolveHashCell,
	storedBlobText,
	storedIndexOf,
	type EditAnswer,
} from "../edit-overlay-support.ts";
import { ownerServerOf, poll, presentBootstrap } from "./owner-supervisor-server.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const BOOT_SECONDS = 61;

const nowSeconds = (world: ChatticusWorld): number => Math.floor(world.clock.now().getTime() / 1000);

async function editAs(
	world: ChatticusWorld,
	userId: string,
	request: Parameters<typeof changeOverlay>[1]["request"],
): Promise<EditAnswer> {
	try {
		return { kind: "recorded", outcome: await changeOverlay(overlayDependenciesOf(world), { tenantId: TENANT, userId, request }) };
	} catch (error) {
		if (error instanceof EditOverlayRefusal) return { kind: "refused", refusal: error };
		throw error;
	}
}

function putRequest(path: string, content: string, ifMatchSha256: string | null) {
	return {
		op: "put" as const,
		path,
		content,
		precondition: ifMatchSha256 === null ? ({ type: "if_none_match" } as const) : ({ type: "if_match", sha256: ifMatchSha256 } as const),
	};
}

async function saveInOverlay(world: ChatticusWorld, userId: string, path: string, content: string): Promise<void> {
	const { view } = await loadEffectiveOverlayView(overlayDependenciesOf(world), TENANT);
	const current = view.hashOf(path);
	const answer = await editAs(world, userId, putRequest(path, content, current));
	assert.equal(answer.kind, "recorded", `Saving ${path} in the overlay was refused: ${answer.kind === "refused" ? answer.refusal.code : ""}`);
}

async function sendOwnerRequest(world: ChatticusWorld, suffix: string, body: unknown, token: string): Promise<{ status: number; body: any }> {
	assert.ok(world.app, "The scenario has no HTTP front door.");
	const response = await world.app.request(`/orgs/${TENANT}/host${suffix}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: any = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	const answer = { status: response.status, body: parsed };
	overlayScenarioOf(world).ownerAnswer = answer;
	return answer;
}

async function startOwnerProcess(world: ChatticusWorld): Promise<void> {
	await ensureMember(world, STORY_TENANT, STORY_USER);
	const store = world.messagingStore();
	const claim = await requestComputerHostStart(
		{ store, clock: world.clock, ids: world.ids, heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds, spend: { store, rollups: world.store, environment: world.budgetEnvironment, clock: world.clock } },
		STORY_TENANT,
		STORY_USER,
	);
	assert.equal(claim.newlyClaimed, true);
	await store.markHostStartDispatched(STORY_TENANT, claim.hostStartGeneration);
	const owner = ownerServerOf(world);
	owner.ownerId = `owner-${world.ids.next()}`;
	owner.computerId = claim.computerId;
	owner.generation = claim.hostStartGeneration;
	await registerWorker(
		{ workerId: owner.ownerId, tenantId: STORY_TENANT, costClass: "local", capabilities: ["cpu", "computer"], computerId: claim.computerId },
		{ store, clock: world.clock, ids: world.ids },
	);
	owner.bootstrapToken = mintOwnerBootstrapToken(SCENARIO_GATEWAY_SIGNING_KEY, {
		audience: "owner-bootstrap",
		tenantId: STORY_TENANT,
		computerId: owner.computerId,
		ownerId: owner.ownerId,
		startGeneration: owner.generation,
		issuedAtSeconds: nowSeconds(world),
		expiresAtSeconds: nowSeconds(world) + OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS,
	});
	owner.nextSequence = 0;
	world.clock.advanceSeconds(BOOT_SECONDS);
}

async function hydratingOwner(world: ChatticusWorld): Promise<void> {
	await startOwnerProcess(world);
	const owner = ownerServerOf(world);
	const bootstrapped = await presentBootstrap(world, owner.bootstrapToken);
	assert.equal(bootstrapped.status, 200, JSON.stringify(bootstrapped.body));
	const polled = await poll(world, "hydrating");
	assert.equal(polled.status, 200, JSON.stringify(polled.body));
}

async function sealWith(world: ChatticusWorld, owner: { ownerId: string; generation: number; token: string }) {
	const answer = await sendOwnerRequest(world, "/owner/overlay-seal", { owner_id: owner.ownerId, generation: owner.generation }, owner.token);
	if (answer.status === 200) overlayScenarioOf(world).sealedEntries = answer.body.entries;
	return answer;
}

const currentOwner = (world: ChatticusWorld) => {
	const owner = ownerServerOf(world);
	return { ownerId: owner.ownerId, generation: owner.generation, token: owner.supervisorToken };
};

Given("the household computer of tenant {string} with members {string} and {string}", async function (this: ChatticusWorld, tenantId: string, first: string, second: string) {
	assert.equal(tenantId, TENANT);
	await ensureMember(this, tenantId, first);
	await ensureMember(this, tenantId, second, "member");
	await ensureComputer(tenantId, { store: this.messagingStore(), ids: this.ids }, COMPUTER_ID);
});

Given("an edit overlay over a snapshot bucket", async function (this: ChatticusWorld) {
	await createFileRoutesBucket(this);
	createOverlayScenario(this);
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
	ownerServerOf(this).frontDoorWired = true;
});

Given("member {string} saved {string} as {string} in the overlay", async function (this: ChatticusWorld, userId: string, path: string, content: string) {
	await saveInOverlay(this, userId, path, content);
});

Given(
	"member {string} saved {string} as {string} and {string} as {string} in the overlay",
	async function (this: ChatticusWorld, userId: string, firstPath: string, firstContent: string, secondPath: string, secondContent: string) {
		await saveInOverlay(this, userId, firstPath, firstContent);
		await saveInOverlay(this, userId, secondPath, secondContent);
	},
);

Given("an owner of the household computer is hydrating", async function (this: ChatticusWorld) {
	await hydratingOwner(this);
});

Given("the owner sealed the overlay", async function (this: ChatticusWorld) {
	const answer = await sealWith(this, currentOwner(this));
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Given("the overlay was sealed by an owner whose heartbeat then lapsed", async function (this: ChatticusWorld) {
	await hydratingOwner(this);
	const answer = await sealWith(this, currentOwner(this));
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	this.clock.advanceSeconds(this.heartbeatTimeoutSeconds * 2);
});

Given("the overlay was sealed by an owner of generation {int}", async function (this: ChatticusWorld, generation: number) {
	await hydratingOwner(this);
	const owner = currentOwner(this);
	assert.equal(owner.generation, generation);
	const answer = await sealWith(this, owner);
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	overlayScenarioOf(this).firstOwner = owner;
});

Given("a newer owner of generation {int} has bootstrapped", async function (this: ChatticusWorld, generation: number) {
	await hydratingOwner(this);
	assert.equal(ownerServerOf(this).generation, generation);
});

Given("the seal of the overlay was replaced by a member write after the owner's heartbeat lapsed", async function (this: ChatticusWorld) {
	this.clock.advanceSeconds(this.heartbeatTimeoutSeconds * 2);
	await saveInOverlay(this, "mia", "/workspace/replaced-the-seal.md", "x");
	const index = await storedIndexOf(this);
	assert.equal(index?.sealed, null);
});

Given("the owner publishes a snapshot and the control plane records it", async function (this: ChatticusWorld) {
	await publishAsOwner(this);
});

async function publishAsOwner(world: ChatticusWorld): Promise<void> {
	const owner = currentOwner(world);
	const answer = await sendOwnerRequest(world, "/snapshot/published", { worker_id: owner.ownerId, checksum: `checksum-${world.ids.next()}` }, owner.token);
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

When(
	"member {string} edits {string} to {string} if it still has the hash of {string}",
	async function (this: ChatticusWorld, userId: string, path: string, content: string, expectedText: string) {
		overlayScenarioOf(this).edit = await editAs(this, userId, putRequest(path, content, hashOfText(expectedText)));
	},
);

async function discardThroughRoute(world: ChatticusWorld, userId: string, path: string, revision: number | null): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const index = await storedIndexOf(world);
	const entry = index?.entries.find((candidate) => candidate.path === path);
	assert.ok(revision !== null || entry, `The overlay has no entry for ${path} to discard.`);
	const route = `/orgs/${TENANT}/computer/files/overlay/discard`;
	const response = await world.api.post(route, {
		headers: await memberHeadersFor(world, TENANT, userId),
		body: { path, revision: revision ?? entry!.revision },
	});
	const text = await response.text();
	overlayScenarioOf(world).routeAnswer = { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

When("member {string} discards the pending edit of {string} through the discard route", async function (this: ChatticusWorld, userId: string, path: string) {
	await discardThroughRoute(this, userId, path, null);
});

When(
	"member {string} discards revision {int} of the pending edit of {string} through the discard route",
	async function (this: ChatticusWorld, userId: string, revision: number, path: string) {
		await discardThroughRoute(this, userId, path, revision);
	},
);

When("the owner seals the overlay", async function (this: ChatticusWorld) {
	const answer = await sealWith(this, currentOwner(this));
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When(
	"the owner seals the overlay at the same instant as member {string} edits {string}",
	async function (this: ChatticusWorld, userId: string, path: string) {
		const scenario = overlayScenarioOf(this);
		const [seal, edit] = await Promise.all([sealWith(this, currentOwner(this)), editAs(this, userId, putRequest(path, "second draft", hashOfText("first draft")))]);
		assert.equal(seal.status, 200, JSON.stringify(seal.body));
		scenario.raceEdit = edit;
		scenario.raceSealEntries = seal.body.entries;
	},
);

When("the owner of generation {int} asks to seal the overlay", async function (this: ChatticusWorld, generation: number) {
	const first = overlayScenarioOf(this).firstOwner;
	assert.ok(first && first.generation === generation, "No owner of that generation was kept.");
	await sealWith(this, first);
});

function clearBody(owner: { ownerId: string; generation: number }, path: string, revision: number) {
	return { owner_id: owner.ownerId, generation: owner.generation, cleared: [{ path, revision }], conflicts: [] };
}

function appliedRevisionOf(world: ChatticusWorld, path: string): number {
	const sealed = overlayScenarioOf(world).sealedEntries;
	assert.ok(sealed, "The owner has not sealed the overlay.");
	const entry = sealed.find((candidate) => candidate.path === path);
	assert.ok(entry, `The sealed set has no entry for ${path}.`);
	return entry.revision;
}

When("the owner of generation {int} asks to clear {string}", async function (this: ChatticusWorld, generation: number, path: string) {
	const first = overlayScenarioOf(this).firstOwner;
	assert.ok(first && first.generation === generation, "No owner of that generation was kept.");
	await sendOwnerRequest(this, "/owner/overlay-applied", clearBody(first, path, 1), first.token);
});

When("the owner asks to clear {string} before it sealed the overlay", async function (this: ChatticusWorld, path: string) {
	const owner = currentOwner(this);
	await sendOwnerRequest(this, "/owner/overlay-applied", clearBody(owner, path, 1), owner.token);
});

When("the owner asks to clear {string} at the revision it applied", async function (this: ChatticusWorld, path: string) {
	const owner = currentOwner(this);
	await sendOwnerRequest(this, "/owner/overlay-applied", clearBody(owner, path, appliedRevisionOf(this, path)), owner.token);
});

When("the owner asks to clear {string} at revision {int}", async function (this: ChatticusWorld, path: string, revision: number) {
	const owner = currentOwner(this);
	await sendOwnerRequest(this, "/owner/overlay-applied", clearBody(owner, path, revision), owner.token);
});

When(
	"the owner reports a conflict for {string} with the disk hash of {string}",
	async function (this: ChatticusWorld, path: string, diskText: string) {
		const owner = currentOwner(this);
		await sendOwnerRequest(
			this,
			"/owner/overlay-applied",
			{ owner_id: owner.ownerId, generation: owner.generation, cleared: [], conflicts: [{ path, revision: appliedRevisionOf(this, path), disk_sha256: hashOfText(diskText) }] },
			owner.token,
		);
	},
);

Then("the overlay answer status is {int}", function (this: ChatticusWorld, status: number) {
	const answer = overlayScenarioOf(this).routeAnswer;
	assert.ok(answer, "No overlay route was called.");
	assert.equal(answer.status, status, JSON.stringify(answer.body));
});

Then("the overlay answer error is {string}", function (this: ChatticusWorld, code: string) {
	assert.equal(overlayScenarioOf(this).routeAnswer?.body?.error, code);
});

Then("the overlay edit is recorded", function (this: ChatticusWorld) {
	const edit = overlayScenarioOf(this).edit;
	assert.ok(edit, "No edit was made.");
	assert.equal(edit.kind, "recorded", edit.kind === "refused" ? `${edit.refusal.code}: ${edit.refusal.message}` : "");
});

function refusalOf(world: ChatticusWorld): EditOverlayRefusal {
	const edit = overlayScenarioOf(world).edit;
	assert.ok(edit && edit.kind === "refused", "The edit was not refused.");
	return edit.refusal;
}

Then("the overlay edit is refused with status {int} and code {string}", function (this: ChatticusWorld, status: number, code: string) {
	const refusal = refusalOf(this);
	assert.equal(refusal.code, code);
	assert.equal(refusal.status, status);
});

Then("the refusal says {string} is {int}", function (this: ChatticusWorld, field: string, value: number) {
	const refusal = refusalOf(this);
	assert.equal(field, "retry_after_ms");
	assert.equal(refusal.retryAfterMs, value);
});

Then("the refusal says {string} is the hash of {string}", function (this: ChatticusWorld, field: string, text: string) {
	assert.equal(field, "current_sha256");
	assert.equal(refusalOf(this).currentSha256, hashOfText(text));
});

Then("the edit overlay holds no entry for {string}", async function (this: ChatticusWorld, path: string) {
	const index = await storedIndexOf(this);
	assert.equal(index?.entries.find((entry) => entry.path === path), undefined);
});

async function entryTextOf(world: ChatticusWorld, path: string) {
	const index = await storedIndexOf(world);
	const entry = index?.entries.find((candidate) => candidate.path === path);
	assert.ok(entry, `The overlay holds no entry for ${path}.`);
	assert.equal(entry.op, "put");
	if (entry.op !== "put") throw new Error("unreachable");
	return { entry, text: await storedBlobText(world, entry.sha256) };
}

Then("the edit overlay holds {string} for {string}", async function (this: ChatticusWorld, content: string, path: string) {
	const { text } = await entryTextOf(this, path);
	assert.equal(text, content);
});

Then("the edit overlay still holds {string} for {string}", async function (this: ChatticusWorld, content: string, path: string) {
	const { text } = await entryTextOf(this, path);
	assert.equal(text, content);
});

Then(
	"the edit overlay holds {string} for {string} with base hash of {string}",
	async function (this: ChatticusWorld, content: string, path: string, baseText: string) {
		const { entry, text } = await entryTextOf(this, path);
		assert.equal(text, content);
		assert.equal(entry.base_sha256, hashOfText(baseText));
	},
);

Then("the edit overlay is not sealed", async function (this: ChatticusWorld) {
	const index = await storedIndexOf(this);
	assert.equal(index?.sealed ?? null, null);
});

Then("the effective hash of {string} is the hash of {string}", async function (this: ChatticusWorld, path: string, text: string) {
	const { view } = await loadEffectiveOverlayView(overlayDependenciesOf(this), TENANT);
	assert.equal(view.hashOf(path), hashOfText(text));
});

Then(
	"the effective view shows {string} with the hash of {string} marked {string} and the person's hash of {string}",
	async function (this: ChatticusWorld, path: string, shownText: string, mark: string, mineText: string) {
		const { view } = await loadEffectiveOverlayView(overlayDependenciesOf(this), TENANT);
		const node = view.lookup(path);
		assert.ok(node, `The effective view has no ${path}.`);
		assert.equal(node.sha256, hashOfText(shownText));
		assert.equal(node.overlay, mark);
		assert.equal(node.mineSha256, hashOfText(mineText));
	},
);

Then("the person's version of {string} in the overlay reads {string}", async function (this: ChatticusWorld, path: string, text: string) {
	const { text: stored } = await entryTextOf(this, path);
	assert.equal(stored, text);
});

Then("the overlay audit trail has no records", function (this: ChatticusWorld) {
	assert.deepEqual(overlayScenarioOf(this).audit.records, []);
});

Then("the overlay audit trail has a record for member {string} with operation {string}", function (this: ChatticusWorld, userId: string, operation: string) {
	const found = overlayScenarioOf(this).audit.records.filter((record) => record.userId === userId && record.operation === operation);
	assert.equal(found.length, 1, JSON.stringify(overlayScenarioOf(this).audit.records));
	assert.equal(found[0]!.source, "overlay");
	assert.equal(found[0]!.outcome, "ok");
});

Then(
	"the overlay audit trail has a record with operation {string} and outcome {string} for {string}",
	function (this: ChatticusWorld, operation: string, outcome: string, path: string) {
		const found = overlayScenarioOf(this).audit.records.filter((record) => record.operation === operation && record.path === path);
		assert.equal(found.length, 1, JSON.stringify(overlayScenarioOf(this).audit.records));
		assert.equal(found[0]!.outcome, outcome);
		assert.equal(found[0]!.userId, "mia");
		assert.ok(found[0]!.ownerId, "An overlay_apply record names the owner.");
	},
);

Then("the blob of {string} is deleted", async function (this: ChatticusWorld, text: string) {
	assert.equal(await storedBlobText(this, hashOfText(text)), null);
});

Then("the blob of {string} is deleted and the blob of {string} is kept", async function (this: ChatticusWorld, deleted: string, kept: string) {
	assert.equal(await storedBlobText(this, hashOfText(deleted)), null);
	assert.equal(await storedBlobText(this, hashOfText(kept)), kept);
});

Then("the sealed entries are exactly:", function (this: ChatticusWorld, table: DataTable) {
	const sealed = overlayScenarioOf(this).sealedEntries;
	assert.ok(sealed, "The owner has not sealed the overlay.");
	const expected = table.hashes().map((row) => ({ path: row["path"]!, sha256: resolveHashCell(row["sha256"]!) }));
	const actual = sealed.map((entry) => ({ path: entry.path, sha256: entry.op === "put" ? entry.sha256 : null }));
	assert.deepEqual(actual, expected);
});

function raceOutcome(world: ChatticusWorld): { inSeal: boolean; waited: boolean } {
	const scenario = overlayScenarioOf(world);
	assert.ok(scenario.raceEdit && scenario.raceSealEntries, "The race was not run.");
	const inSeal = scenario.raceSealEntries.some((entry) => entry.path === "/workspace/notes.md");
	const waited = scenario.raceEdit.kind === "refused" && scenario.raceEdit.refusal.code === "computer_starting";
	return { inSeal, waited };
}

Then("either the sealed entries hold the edit or the edit was answered {string}", function (this: ChatticusWorld, code: string) {
	assert.equal(code, "computer_starting");
	const { inSeal, waited } = raceOutcome(this);
	assert.ok(inSeal || waited, "The edit is neither in the sealed set nor told to wait.");
});

Then("never both and never neither", function (this: ChatticusWorld) {
	const { inSeal, waited } = raceOutcome(this);
	assert.notEqual(inSeal, waited);
});

Then("the owner request is refused with code {string}", function (this: ChatticusWorld, code: string) {
	const answer = overlayScenarioOf(this).ownerAnswer;
	assert.ok(answer, "The owner made no request.");
	assert.ok(answer.status === 403 || answer.status === 409, JSON.stringify(answer));
	assert.equal(answer.body?.code, code);
});

Then(/^the owner request is answered with (\d+) (?:entry|entries) remaining$/, async function (this: ChatticusWorld, remaining: string) {
	const answer = overlayScenarioOf(this).ownerAnswer;
	assert.ok(answer, "The owner made no request.");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(answer.body.remaining, Number(remaining));
});
