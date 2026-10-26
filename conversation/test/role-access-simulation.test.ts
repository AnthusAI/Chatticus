import { describe, expect, it } from "vitest";
import { secretParameterArnsOf, type AccessDenialRow, type AccessRow, type StoreArns } from "../src/gateway/role-access-manifest.ts";
import { denialSimulationCasesOf, simulationCasesOf, simulationGroupsOf, simulationResultsOf, simulationSummaryOf, type SimulationCase } from "../src/gateway/role-access-simulation.ts";

const ARNS: StoreArns = {
	messagingTable: "arn:aws:dynamodb:us-east-1:111122223333:table/messaging",
	conversationsTable: "arn:aws:dynamodb:us-east-1:111122223333:table/conversations",
	piSessionsBucket: "arn:aws:s3:::pi-sessions",
	snapshotBucket: "arn:aws:s3:::snapshots",
	channelEventBus: "arn:aws:events:us-east-1:111122223333:event-bus/default",
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
			"PASS role access development: 2 of 2 allowed (frontDoor 2, ownerTurn 0, supervisor 0, turnExecutor 0)",
		);
	});

	it("says FAIL and names each denied case", () => {
		const line = simulationSummaryOf("development", [{ simulationCase: first!, decision: "allowed" }, { simulationCase: second!, decision: "implicitDeny" }]);
		expect(line.startsWith("FAIL role access development: 1 of 2 allowed")).toBe(true);
		expect(line).toContain("listing the bucket without a prefix so a missing key answers 404");
	});
});

const baseCase = (overrides: Partial<SimulationCase>): SimulationCase => ({
	role: "frontDoor",
	description: "case",
	action: "s3:GetObject",
	resourceArn: "arn:aws:s3:::snapshots/a",
	contextEntries: [{ ContextKeyName: "aws:PrincipalTag/tenant", ContextKeyValues: ["anthus"], ContextKeyType: "string" }],
	...overrides,
});

describe("grouping the cases into few policy simulator calls", () => {
	it("collapses cases with the same role, resource and context into one group holding every action", () => {
		const groups = simulationGroupsOf([
			baseCase({ action: "s3:GetObject", description: "one" }),
			baseCase({ action: "s3:PutObject", description: "two" }),
			baseCase({ action: "s3:GetObject", description: "three" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.actions).toEqual(["s3:GetObject", "s3:PutObject"]);
		expect(groups[0]!.cases.map((simulationCase) => simulationCase.description)).toEqual(["one", "two", "three"]);
	});

	it("keeps cases apart when the role, resource or context differs, in first-seen order", () => {
		const groups = simulationGroupsOf([
			baseCase({ role: "supervisor" }),
			baseCase({ resourceArn: "arn:aws:s3:::snapshots/b" }),
			baseCase({ contextEntries: [] }),
			baseCase({ role: "supervisor", action: "s3:PutObject" }),
		]);
		expect(groups.map((group) => [group.role, group.resourceArn, group.contextEntries.length, group.actions])).toEqual([
			["supervisor", "arn:aws:s3:::snapshots/a", 1, ["s3:GetObject", "s3:PutObject"]],
			["frontDoor", "arn:aws:s3:::snapshots/b", 1, ["s3:GetObject"]],
			["frontDoor", "arn:aws:s3:::snapshots/a", 0, ["s3:GetObject"]],
		]);
	});

	it("maps every evaluation back to each case of its action", () => {
		const [group] = simulationGroupsOf([baseCase({ action: "s3:GetObject", description: "one" }), baseCase({ action: "s3:PutObject", description: "two" }), baseCase({ action: "s3:GetObject", description: "three" })]);
		const results = simulationResultsOf(group!, [
			{ EvalActionName: "s3:PutObject", EvalDecision: "implicitDeny" },
			{ EvalActionName: "s3:GetObject", EvalDecision: "allowed" },
		]);
		expect(results.map((result) => [result.simulationCase.description, result.decision])).toEqual([
			["one", "allowed"],
			["two", "implicitDeny"],
			["three", "allowed"],
		]);
	});

	it("fails loudly when an action has no evaluation", () => {
		const [group] = simulationGroupsOf([baseCase({ action: "s3:GetObject" }), baseCase({ action: "s3:PutObject" })]);
		expect(() => simulationResultsOf(group!, [{ EvalActionName: "s3:GetObject", EvalDecision: "allowed" }])).toThrow(/s3:PutObject/);
	});
});

describe("the denial cases put to the IAM policy simulator", () => {
	const denial: AccessDenialRow = { role: "supervisor", action: "ssm:GetParameter", parameter: "signingKeyParameter" };
	const arns = secretParameterArnsOf("us-east-1", "111122223333", "development");

	it("names the parameter ARN of the environment and expects a denial", () => {
		expect(arns.operatorKeyParameter).toBe("arn:aws:ssm:us-east-1:111122223333:parameter/chatticus/development/thin-turn/operator-key");
		expect(arns.signingKeyParameter).toBe("arn:aws:ssm:us-east-1:111122223333:parameter/chatticus/development/model-gateway/signing-key");
		const [only] = denialSimulationCasesOf([denial], arns);
		expect(only!.resourceArn).toBe(arns.signingKeyParameter);
		expect(only!.expectation).toBe("denied");
	});

	it("passes a denial that was denied and fails one that was allowed", () => {
		const [only] = denialSimulationCasesOf([denial], arns);
		expect(simulationSummaryOf("development", [{ simulationCase: only!, decision: "implicitDeny" }])).toBe(
			"PASS role access development: 0 of 0 allowed, 1 of 1 denied as required (frontDoor 0, ownerTurn 0, supervisor 1, turnExecutor 0)",
		);
		const line = simulationSummaryOf("development", [{ simulationCase: only!, decision: "allowed" }]);
		expect(line.startsWith("FAIL role access development")).toBe(true);
		expect(line).toContain("wrongly allowed: supervisor must be denied ssm:GetParameter on signingKeyParameter");
	});
});
