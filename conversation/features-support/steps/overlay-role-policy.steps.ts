import assert from "node:assert/strict";
import { Given, Then } from "@cucumber/cucumber";
import type { S3Client } from "@aws-sdk/client-s3";
import { supervisorSessionTags } from "../../src/gateway/session-tags.ts";
import { S3OverlayStore } from "../../src/snapshot/overlay-store.ts";
import { createFileRoutesBucket, fileRoutesOf } from "../computer-snapshot-files-support.ts";
import { createOverlayScenario } from "../edit-overlay-support.ts";
import { recordingS3Client } from "../aws-request-recorder.ts";
import { frontDoorRequestsOf } from "../front-door-request-recording.ts";
import { wireFrontDoor } from "../front-door.ts";
import { testS3Client } from "../pi-storage.ts";
import { ownerServerOf } from "./owner-supervisor-server.steps.ts";
import { policyAllows, supervisorRolePolicyStatements, type AuthorizedRequest } from "../iam-policy-evaluator.ts";
import { FIXED_STORE_NAMES, ownerRoleFor, type OwnerRole } from "../owner-role-support.ts";
import type { ChatticusWorld } from "../world.ts";

const OVERLAY_TENANT = "anthus";
const OVERLAY_COMPUTER = "household-computer";
const OVERLAY_ACTIONS = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectTagging", "s3:AbortMultipartUpload"];

function perTurnRole(): OwnerRole {
	return ownerRoleFor({ tenantId: OVERLAY_TENANT, botId: "bot-1", channelId: "channel-1", computerId: OVERLAY_COMPUTER, turnId: "turn-1" });
}

function supervisorRole(): OwnerRole {
	return {
		statements: supervisorRolePolicyStatements({ snapshotBucketArn: `arn:aws:s3:::${FIXED_STORE_NAMES.snapshotBucket}` }),
		tags: Object.fromEntries(supervisorSessionTags({ tenantId: OVERLAY_TENANT, computerId: OVERLAY_COMPUTER }).map((tag) => [tag.Key, tag.Value])),
	};
}

function objectRequest(action: string, key: string): AuthorizedRequest {
	return { action, resourceArn: `arn:aws:s3:::${FIXED_STORE_NAMES.snapshotBucket}/${key}`, contextKeys: {} };
}

function actionsOf(text: string): string[] {
	return text.split(/,\s*|\s+and\s+/).map((action) => action.trim()).filter((action) => action !== "");
}

function assertVerdict(role: OwnerRole, roleName: string, actionsText: string, key: string, expected: boolean): void {
	for (const action of actionsOf(actionsText)) {
		const request = objectRequest(action, key);
		assert.equal(policyAllows(role.statements, role.tags, request), expected, `${roleName} ${expected ? "denied" : "allowed"} ${action} on ${key}`);
	}
}

Then(/^the per-turn role policy denies (s3:[A-Za-z0-9, :]+?) on "([^"]+)"$/, function (this: ChatticusWorld, actions: string, key: string) {
	assertVerdict(perTurnRole(), "the per-turn role", actions, key, false);
});

Then(/^the supervisor role policy allows (s3:[A-Za-z0-9, :]+?) on "([^"]+)"$/, function (this: ChatticusWorld, actions: string, key: string) {
	assertVerdict(supervisorRole(), "the supervisor role", actions, key, true);
});

Then(/^the supervisor role policy still allows (s3:[A-Za-z0-9, :]+?) on "([^"]+)"$/, function (this: ChatticusWorld, actions: string, key: string) {
	assertVerdict(supervisorRole(), "the supervisor role", actions, key, true);
});

Then(/^the supervisor role policy denies (s3:[A-Za-z0-9, :]+?) on "([^"]+)"$/, function (this: ChatticusWorld, actions: string, key: string) {
	assertVerdict(supervisorRole(), "the supervisor role", actions, key, false);
});

Then("the supervisor role policy denies every action on the overlay of another computer", function (this: ChatticusWorld) {
	const role = supervisorRole();
	for (const key of [
		"tenants/anthus/computers/other-computer/overlay/index.json",
		"tenants/anthus/computers/other-computer/overlay/blobs/abc",
		"tenants/other/computers/household-computer/overlay/index.json",
	]) {
		for (const action of OVERLAY_ACTIONS) {
			assert.equal(policyAllows(role.statements, role.tags, objectRequest(action, key)), false, `${action} on ${key} was allowed`);
		}
	}
});

type RecordedPut = { readonly key: string; readonly ifMatch: string | undefined; readonly ifNoneMatch: string | undefined; readonly etag: string | undefined };

const putsByWorld = new WeakMap<ChatticusWorld, RecordedPut[]>();

function recordingOverlayClient(puts: RecordedPut[]): S3Client {
	const client = testS3Client();
	client.middlewareStack.add(
		(next) => async (args) => {
			const result = await next(args);
			if (args.input !== undefined && "Key" in (args.input as object) && "Body" in (args.input as object)) {
				const input = args.input as { Key: string; IfMatch?: string; IfNoneMatch?: string };
				puts.push({ key: input.Key, ifMatch: input.IfMatch, ifNoneMatch: input.IfNoneMatch, etag: (result.output as { ETag?: string }).ETag });
			}
			return result;
		},
		{ step: "initialize", name: "recordOverlayPuts" },
	);
	return client;
}

Given("an edit overlay kept in the snapshot bucket itself", async function (this: ChatticusWorld) {
	await createFileRoutesBucket(this);
	const puts: RecordedPut[] = [];
	putsByWorld.set(this, puts);
	const bucket = fileRoutesOf(this).bucket;
	assert.ok(bucket, "The scenario has no snapshot bucket.");
	createOverlayScenario(this, new S3OverlayStore(bucket, recordingS3Client(recordingOverlayClient(puts), frontDoorRequestsOf(this))));
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
	ownerServerOf(this).frontDoorWired = true;
});

function overlayPutsOf(world: ChatticusWorld, kind: "blobs" | "index"): RecordedPut[] {
	const puts = putsByWorld.get(world);
	assert.ok(puts, "The overlay of this scenario is not kept in the snapshot bucket.");
	return puts.filter((put) => (kind === "index" ? put.key.endsWith("/overlay/index.json") : put.key.includes("/overlay/blobs/")));
}

Then("the overlay blob was put with {string}", function (this: ChatticusWorld, header: string) {
	assert.equal(header, "If-None-Match: *");
	const blobs = overlayPutsOf(this, "blobs");
	assert.ok(blobs.length >= 2, `Expected at least two blob writes, saw ${blobs.length}.`);
	for (const put of blobs) {
		assert.equal(put.ifNoneMatch, "*", `A blob was written without If-None-Match: ${put.key}`);
		assert.equal(put.ifMatch, undefined);
	}
});

Then("the overlay index was put with a condition on the entity tag it had read", function (this: ChatticusWorld) {
	const indexes = overlayPutsOf(this, "index");
	assert.ok(indexes.length >= 2, `Expected at least two index writes, saw ${indexes.length}.`);
	assert.equal(indexes[0]!.ifNoneMatch, "*", "The first write of the index must be a create-only write.");
	for (let position = 1; position < indexes.length; position += 1) {
		assert.ok(indexes[position - 1]!.etag, "The previous write returned no entity tag.");
		assert.equal(indexes[position]!.ifMatch, indexes[position - 1]!.etag, "A later write of the index must name the entity tag it had read.");
		assert.equal(indexes[position]!.ifNoneMatch, undefined);
	}
});
