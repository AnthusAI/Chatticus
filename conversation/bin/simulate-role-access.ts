#!/usr/bin/env node

/**
 * Post-deploy check of the deployed roles against the role access manifest, with the IAM policy simulator.
 *
 * Read-only: it describes the ControlPlane stack, reads the FrontDoor function configuration, and calls
 * `iam:SimulatePrincipalPolicy`, which evaluates the roles' attached policies and changes nothing. It needs credentials that
 * may call `cloudformation:DescribeStackResources`, `lambda:GetFunctionConfiguration`, `sts:GetCallerIdentity` and
 * `iam:SimulatePrincipalPolicy`; it never writes. Run it from a logged-in operator shell after a deploy:
 *
 *   npx tsx bin/simulate-role-access.ts --environment development
 *
 * It prints one summary line, naming each denied case, and exits 1 when any case is denied. The offline
 * guard (role_access_manifest.feature and infra/test/role-access-policy.test.ts) is what gates a merge; this is the check
 * that the account really holds what the guard proved.
 */

import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { loadRoleAccessManifest, type AccessRole, type StoreArns } from "../src/gateway/role-access-manifest.ts";
import { simulationCasesOf, simulationSummaryOf, type SimulationResult } from "../src/gateway/role-access-simulation.ts";

const REGION = "us-east-1";

const CONTROL_PLANE_STACKS: Record<string, string> = {
	development: "ChatticusControlPlane",
	staging: "ChatticusControlPlaneStaging",
	production: "ChatticusControlPlaneProduction",
};

const ROLE_LOGICAL_ID_PATTERNS: Record<AccessRole, RegExp> = {
	frontDoor: /^FrontDoorServiceRole[0-9A-F]+$/,
	ownerTurn: /^ComputerOwnerScopedRole[0-9A-F]+$/,
	supervisor: /^ComputerSupervisorRole[0-9A-F]+$/,
};

class UsageError extends Error {}

function environmentOf(argv: readonly string[]): string {
	const position = argv.indexOf("--environment");
	const environment = position === -1 ? undefined : argv[position + 1];
	if (environment === undefined || CONTROL_PLANE_STACKS[environment] === undefined) {
		throw new UsageError("usage: simulate-role-access.ts --environment development|staging|production");
	}
	return environment;
}

async function main(): Promise<void> {
	const environment = environmentOf(process.argv.slice(2));
	const account = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
	const resources =
		(await new CloudFormationClient({ region: REGION }).send(new DescribeStackResourcesCommand({ StackName: CONTROL_PLANE_STACKS[environment]! }))).StackResources ?? [];

	const roleArns = {} as Record<AccessRole, string>;
	for (const role of Object.keys(ROLE_LOGICAL_ID_PATTERNS) as AccessRole[]) {
		const match = resources.find((resource) => resource.ResourceType === "AWS::IAM::Role" && ROLE_LOGICAL_ID_PATTERNS[role].test(resource.LogicalResourceId ?? ""));
		if (match?.PhysicalResourceId === undefined) throw new Error(`The ${CONTROL_PLANE_STACKS[environment]} stack has no role for ${role}.`);
		roleArns[role] = `arn:aws:iam::${account}:role/${match.PhysicalResourceId}`;
	}

	const frontDoor = resources.find((resource) => resource.ResourceType === "AWS::Lambda::Function" && /^FrontDoor[0-9A-F]+$/.test(resource.LogicalResourceId ?? ""));
	if (frontDoor?.PhysicalResourceId === undefined) throw new Error("The stack has no FrontDoor function.");
	const variables = (await new LambdaClient({ region: REGION }).send(new GetFunctionConfigurationCommand({ FunctionName: frontDoor.PhysicalResourceId }))).Environment?.Variables ?? {};
	const variable = (name: string): string => {
		const value = variables[name];
		if (value === undefined) throw new Error(`The FrontDoor function has no ${name} variable.`);
		return value;
	};
	const arns: StoreArns = {
		messagingTable: `arn:aws:dynamodb:${REGION}:${account}:table/${variable("CHATTICUS_MESSAGING_TABLE")}`,
		conversationsTable: `arn:aws:dynamodb:${REGION}:${account}:table/${variable("CHATTICUS_CONVERSATIONS_TABLE")}`,
		piSessionsBucket: `arn:aws:s3:::${variable("CHATTICUS_PI_SESSIONS_BUCKET")}`,
		snapshotBucket: `arn:aws:s3:::${variable("CHATTICUS_SNAPSHOT_BUCKET")}`,
	};

	const iam = new IAMClient({ region: REGION });
	const results: SimulationResult[] = [];
	for (const simulationCase of simulationCasesOf(loadRoleAccessManifest(), arns)) {
		const response = await iam.send(
			new SimulatePrincipalPolicyCommand({
				PolicySourceArn: roleArns[simulationCase.role],
				ActionNames: [simulationCase.action],
				ResourceArns: [simulationCase.resourceArn],
				ContextEntries: simulationCase.contextEntries.map((entry) => ({ ...entry, ContextKeyValues: [...entry.ContextKeyValues] })),
			}),
		);
		results.push({ simulationCase, decision: response.EvaluationResults?.[0]?.EvalDecision ?? "no result" });
	}

	console.info(simulationSummaryOf(environment, results));
	if (results.some((result) => result.decision !== "allowed")) process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = error instanceof UsageError ? 2 : 1;
});
