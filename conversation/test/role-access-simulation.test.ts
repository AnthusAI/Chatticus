import { describe, expect, it } from "vitest";
import type { AccessRow, StoreArns } from "../src/gateway/role-access-manifest.ts";
import { simulationCasesOf, simulationSummaryOf } from "../src/gateway/role-access-simulation.ts";

const ARNS: StoreArns = {
	messagingTable: "arn:aws:dynamodb:us-east-1:111122223333:table/messaging",
	conversationsTable: "arn:aws:dynamodb:us-east-1:111122223333:table/conversations",
	piSessionsBucket: "arn:aws:s3:::pi-sessions",
	snapshotBucket: "arn:aws:s3:::snapshots",
};

const tableRow: AccessRow = {
	role: "ownerTurn",
	action: "dynamodb:Query",
	store: "messagingTable",
	keyPattern: "^MB#",
	exampleKey: "MB#{tenantId}#{botId}#{channelId}",
};

const readRow: AccessRow = {
	role: "frontDoor",
	action: "s3:GetObject",
	store: "snapshotBucket",
	keyPattern: "^tenants/",
	exampleKey: "tenants/{tenantId}/computers/{computerId}/manifest.json",
};

describe("the cases put to the IAM policy simulator", () => {
	it("gives a table row its leading key as a string list and the session tags as principal tags", () => {
		const [only] = simulationCasesOf([tableRow], ARNS);
		expect(simulationCasesOf([tableRow], ARNS)).toHaveLength(1);
		expect(only!.resourceArn).toBe(ARNS.messagingTable);
		expect(only!.contextEntries).toContainEqual({ ContextKeyName: "dynamodb:LeadingKeys", ContextKeyValues: ["MB#anthus#bot-1#channel-1"], ContextKeyType: "stringList" });
		expect(only!.contextEntries).toContainEqual({ ContextKeyName: "aws:PrincipalTag/tenant", ContextKeyValues: ["anthus"], ContextKeyType: "string" });
	});

	it("adds the question that decides 404 against 403 for an object read whose key may be missing", () => {
		const cases = simulationCasesOf([readRow], ARNS);
		expect(cases.map((simulationCase) => [simulationCase.action, simulationCase.resourceArn])).toEqual([
			["s3:GetObject", "arn:aws:s3:::snapshots/tenants/anthus/computers/computer-1/manifest.json"],
			["s3:ListBucket", "arn:aws:s3:::snapshots"],
		]);
		expect(cases[1]!.contextEntries).toEqual([]);
	});

	it("asks nothing more for an object read whose key always exists", () => {
		expect(simulationCasesOf([{ ...readRow, keyAlwaysExists: true }], ARNS)).toHaveLength(1);
	});
});

describe("the post-deploy summary line", () => {
	const [first, second] = simulationCasesOf([readRow], ARNS);

	it("says PASS and counts the cases per role when every case is allowed", () => {
		expect(simulationSummaryOf("development", [{ simulationCase: first!, decision: "allowed" }, { simulationCase: second!, decision: "allowed" }])).toBe(
			"PASS role access development: 2 of 2 allowed (frontDoor 2, ownerTurn 0, supervisor 0)",
		);
	});

	it("says FAIL and names each denied case", () => {
		const line = simulationSummaryOf("development", [{ simulationCase: first!, decision: "allowed" }, { simulationCase: second!, decision: "implicitDeny" }]);
		expect(line.startsWith("FAIL role access development: 1 of 2 allowed")).toBe(true);
		expect(line).toContain("listing the bucket without a prefix so a missing key answers 404");
	});
});
