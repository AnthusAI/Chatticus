import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { computerForOrganization } from "../../src/domain/computers.ts";
import { getTurn } from "../../src/domain/turns.ts";
import { buildOwnerSessionPolicy, type OwnerSessionScope, type SessionPolicyDocument } from "../../src/gateway/session-policy.ts";
import { S3SnapshotStore } from "../../src/snapshot/s3.ts";
import { type RecordedAwsRequest, tableArnOf } from "../aws-request-recorder.ts";
import { grantPayloadOfTable, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import { computerOwnerScenarioOf } from "../computer-owner.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { createOrganizationBucket } from "../host-lifecycle-support.ts";
import { policyAllows } from "../iam-policy-evaluator.ts";
import { recordedOwnerRequestsOf, startRecordingOwnerRequests } from "../owner-request-recording.ts";
import { ensurePiStorage, testS3Client } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";

Given("the requests of the computer owners are recorded", function (this: ChatticusWorld) {
	startRecordingOwnerRequests(this);
});

Given("an S3 snapshot bucket bound to the host worker", async function (this: ChatticusWorld) {
	const bucket = `owner-snapshots-${randomUUID()}`;
	await createOrganizationBucket(this, bucket);
	this.computerHosts = {};
	this.snapshotStore = new S3SnapshotStore(bucket, testS3Client());
});

When("the organization sets a monthly AWS spend ceiling of {string} dollars", async function (this: ChatticusWorld, amount: string) {
	const organization = await this.messagingStore().getOrganization(STORY_TENANT);
	assert.ok(organization, "The story organization does not exist yet.");
	await this.messagingStore().putOrganization({ ...organization, monthlyAwsSpendCeilingUsd: Decimal.parse(amount) });
});

When("the member allows the turn tool {string} to reach the origin {string}", async function (this: ChatticusWorld, tool: string, origin: string) {
	const headers = await memberHeadersFor(this, STORY_TENANT, "ryan");
	const response = await putActiveTurnGrant(
		this,
		headers,
		grantPayloadOfTable({ tools: tool, origins: origin, recipients: "", file_scopes: "", egress_classes: "approved_origin_fetch", ingest_classes: "" }),
	);
	assert.equal(response.status, 200, response.text);
});

async function ownerPolicyOfScenario(world: ChatticusWorld): Promise<SessionPolicyDocument> {
	const scenario = computerOwnerScenarioOf(world);
	const turnId = scenario.turnIds[0] ?? world.lastTurnId;
	assert.ok(turnId, "The scenario started no turn.");
	const turn = await getTurn(world.turnDependencies(), STORY_TENANT, turnId);
	const storage = await ensurePiStorage(world);
	const computer = await computerForOrganization(STORY_TENANT, { store: world.messagingStore() });
	const snapshotBucket = (world.snapshotStore as S3SnapshotStore | null)?.bucket ?? "owner-snapshots-unbound";
	const scope: OwnerSessionScope = {
		tenantId: STORY_TENANT,
		botId: turn.botId,
		channelId: turn.channelId,
		bucketName: storage.bucket,
		conversationsTableArn: tableArnOf(storage.tableName),
		computerId: computer.computerId,
		snapshotBucketName: snapshotBucket,
		messagingTableArn: tableArnOf(world.messagingTable.tableName),
	};
	return buildOwnerSessionPolicy(scope);
}

const describeRequest = (request: RecordedAwsRequest): string =>
	`${request.action} ${request.resourceArn} key=${request.keys.length === 0 ? "(none)" : request.keys.join(",")}`;

function printRecordedShapes(requests: readonly RecordedAwsRequest[]): void {
	if (process.env["CHATTICUS_PRINT_OWNER_REQUESTS"] !== "1") return;
	const shapes = new Set(requests.map((request) => `${request.action} ${request.store.replace(/-[0-9a-f-]{36}$/, "-<uuid>")} ${request.keys.join(",")}`));
	for (const shape of [...shapes].sort()) console.info(`owner_request ${shape}`);
}

Then("every request the computer owners made is allowed by the owner session policy", async function (this: ChatticusWorld) {
	const requests = recordedOwnerRequestsOf(this);
	assert.ok(requests.length > 0, "The scenario recorded no owner request.");
	printRecordedShapes(requests);
	const policy = await ownerPolicyOfScenario(this);
	const denied = requests.filter((request) => !policyAllows(policy, request));
	const distinct = [...new Set(denied.map(describeRequest))];
	assert.equal(distinct.length, 0, `The owner session policy would deny ${distinct.length} request(s):\n${distinct.join("\n")}`);
});

Then(
	"the computer owners made a {string} request on a key starting {string}",
	function (this: ChatticusWorld, action: string, keyPrefix: string) {
		const keys = recordedOwnerRequestsOf(this).filter((request) => request.action === action).flatMap((request) => request.keys);
		assert.ok(keys.some((key) => key.startsWith(keyPrefix)), `No ${action} request on a key starting ${keyPrefix}; saw ${[...new Set(keys)].join(" | ")}`);
	},
);

Then("the computer owners made no {string} request", function (this: ChatticusWorld, action: string) {
	const found = recordedOwnerRequestsOf(this).filter((request) => request.action === action).map(describeRequest);
	assert.deepEqual([...new Set(found)], []);
});
