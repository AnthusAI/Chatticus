import assert from "node:assert/strict";
import { Then } from "@cucumber/cucumber";
import { supervisorSessionTags } from "../../src/gateway/session-tags.ts";
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
