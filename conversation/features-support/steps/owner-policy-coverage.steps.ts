import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { S3SnapshotStore } from "../../src/snapshot/s3.ts";
import { type RecordedAwsRequest } from "../aws-request-recorder.ts";
import { grantPayloadOfTable, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { testS3Client } from "../pi-storage.ts";
import { createOrganizationBucket } from "../host-lifecycle-support.ts";
import { policyAllows } from "../iam-policy-evaluator.ts";
import { ownerRoleOfScenario, supervisorRoleOfScenario } from "../owner-role-support.ts";
import { recordedOwnerRequestsOf, recordedSupervisorRequestsOf, startRecordingOwnerRequests } from "../owner-request-recording.ts";
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

const describeRequest = (request: RecordedAwsRequest): string =>
	`${request.action} ${request.resourceArn} key=${request.keys.length === 0 ? "(none)" : request.keys.join(",")}`;

function printRecordedShapes(requests: readonly RecordedAwsRequest[]): void {
	if (process.env["CHATTICUS_PRINT_OWNER_REQUESTS"] !== "1") return;
	const shapes = new Set(requests.map((request) => `${request.action} ${request.store.replace(/-[0-9a-f-]{36}$/, "-<uuid>")} ${request.keys.join(",")}`));
	for (const shape of [...shapes].sort()) console.info(`owner_request ${shape}`);
}

Then("every request the computer owners made is allowed by the owner role policy", async function (this: ChatticusWorld) {
	const requests = recordedOwnerRequestsOf(this);
	assert.ok(requests.length > 0, "The scenario recorded no owner request.");
	printRecordedShapes(requests);
	const role = await ownerRoleOfScenario(this);
	const denied = requests.filter((request) => !policyAllows(role.statements, role.tags, request));
	const distinct = [...new Set(denied.map(describeRequest))];
	assert.equal(distinct.length, 0, `The owner role policy would deny ${distinct.length} request(s):\n${distinct.join("\n")}`);
});

Then("every snapshot request the supervisor made is allowed by the supervisor role policy", async function (this: ChatticusWorld) {
	const requests = recordedSupervisorRequestsOf(this);
	assert.ok(requests.length > 0, "The scenario recorded no supervisor request.");
	const role = await supervisorRoleOfScenario(this);
	const denied = requests.filter((request) => !policyAllows(role.statements, role.tags, request));
	const distinct = [...new Set(denied.map(describeRequest))];
	assert.equal(distinct.length, 0, `The supervisor role policy would deny ${distinct.length} request(s):\n${distinct.join("\n")}`);
});

Then("the supervisor made a {string} request on a key starting {string}", function (this: ChatticusWorld, action: string, keyPrefix: string) {
	const keys = recordedSupervisorRequestsOf(this).filter((request) => request.action === action).flatMap((request) => request.keys);
	assert.ok(keys.some((key) => key.startsWith(keyPrefix)), `No ${action} request on a key starting ${keyPrefix}; saw ${[...new Set(keys)].join(" | ")}`);
});

Then("the supervisor made no write request on the edit overlay", function (this: ChatticusWorld) {
	const writeActions = new Set(["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectTagging", "s3:AbortMultipartUpload"]);
	const found = recordedSupervisorRequestsOf(this).filter(
		(request) => writeActions.has(request.action) && request.keys.some((key) => key.includes("/overlay/")),
	);
	assert.deepEqual(found.map(describeRequest), []);
});

Then("the computer owners made no request on the snapshot bucket",function (this: ChatticusWorld) {
	const found = recordedOwnerRequestsOf(this).filter((request) => request.service === "s3" && request.keys.some((key) => key.startsWith("tenants/")));
	assert.deepEqual(found.map(describeRequest), []);
});

Then(
	"the computer owners made a {string} request on a key starting {string}",
	function (this: ChatticusWorld, action: string, keyPrefix: string) {
		const keys = recordedOwnerRequestsOf(this).filter((request) => request.action === action).flatMap((request) => request.keys);
		assert.ok(keys.some((key) => key.startsWith(keyPrefix)), `No ${action} request on a key starting ${keyPrefix}; saw ${[...new Set(keys)].join(" | ")}`);
	},
);

