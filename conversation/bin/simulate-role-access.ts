#!/usr/bin/env node

/**
 * Post-deploy check of the deployed roles against the role access manifest, with the IAM policy simulator.
 *
 * Read-only: it describes the ControlPlane stack, reads the FrontDoor function configuration, and calls
 * `iam:SimulatePrincipalPolicy`, which evaluates the roles' attached policies and changes nothing. It needs credentials that
 * may call `cloudformation:DescribeStackResources`, `lambda:GetFunctionConfiguration`, `sts:GetCallerIdentity` and
 * `iam:SimulatePrincipalPolicy`; it never writes. All three environments live in the one production AWS account, so run
 * it from an operator shell logged in to that account (AWS_PROFILE=chatticus-production) after a deploy:
 *
 *   AWS_PROFILE=chatticus-production npx tsx bin/simulate-role-access.ts --environment development
 *
 * It also asks whether the owner and supervisor roles may read the operator key and signing key parameters (the manifest's
 * denial rows) and expects a denial. It prints one summary line, naming each case answered wrongly, and exits 1 when any is. The offline
 * guard (role_access_manifest.feature and infra/test/role-access-policy.test.ts) is what gates a merge; this is the check
 * that the account really holds what the guard proved.
 */

import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { loadRoleAccessDenials, loadRoleAccessManifest, secretParameterArnsOf, type AccessRole, type StoreArns } from "../src/gateway/role-access-manifest.ts";
import {
	denialSimulationCasesOf,
	resultAsRequired,
	simulationCasesOf,
	simulationGroupsOf,
	simulationResultsOf,
	simulationSummaryOf,
	type SimulationEvaluation,
	type SimulationResult,
} from "../src/gateway/role-access-simulation.ts";

const REGION = "us-east-1";

const IAM_MAX_ATTEMPTS = 10;

const DEFAULT_DELAY_BETWEEN_CALLS_MILLISECONDS = 1000;

/**
 * The pause between simulator calls, which IAM throttles hard. `CHATTICUS_SIMULATION_DELAY_MS` overrides the default of
 * one second; `0` turns the pause off.
 */
function delayMillisecondsOf(environment: NodeJS.ProcessEnv): number {
	const configured = environment.CHATTICUS_SIMULATION_DELAY_MS;
	if (configured === undefined || configured === "") return DEFAULT_DELAY_BETWEEN_CALLS_MILLISECONDS;
	const parsed = Number(configured);
	if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError("CHATTICUS_SIMULATION_DELAY_MS must be a non-negative integer.");
	return parsed;
}

const CONTROL_PLANE_STACKS: Record<string, string> = {
	development: "ChatticusControlPlaneDevelopment",
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

	const iam = new IAMClient({ region: REGION, maxAttempts: IAM_MAX_ATTEMPTS, retryMode: "adaptive" });
	const groups = simulationGroupsOf([
		...simulationCasesOf(loadRoleAccessManifest(), arns),
		...denialSimulationCasesOf(loadRoleAccessDenials(), secretParameterArnsOf(REGION, account ?? "", environment)),
	]);
	const delayMilliseconds = delayMillisecondsOf(process.env);
	const results: SimulationResult[] = [];
	for (const [index, group] of groups.entries()) {
		if (index > 0 && delayMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
		console.error(`simulating group ${index + 1} of ${groups.length}: ${group.role}, ${group.actions.length} action(s)`);
		const evaluations: SimulationEvaluation[] = [];
		let marker: string | undefined;
		do {
			const response = await iam.send(
				new SimulatePrincipalPolicyCommand({
					PolicySourceArn: roleArns[group.role],
					ActionNames: [...group.actions],
					ResourceArns: [group.resourceArn],
					ContextEntries: group.contextEntries.map((entry) => ({ ...entry, ContextKeyValues: [...entry.ContextKeyValues] })),
					Marker: marker,
				}),
			);
			evaluations.push(...(response.EvaluationResults ?? []));
			marker = response.IsTruncated === true ? response.Marker : undefined;
		} while (marker !== undefined);
		results.push(...simulationResultsOf(group, evaluations));
	}

	console.info(simulationSummaryOf(environment, results));
	if (results.some((result) => !resultAsRequired(result))) process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = error instanceof UsageError ? 2 : 1;
});
