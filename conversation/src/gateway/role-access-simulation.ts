import {
	ACCESS_ROLES,
	describeRow,
	exampleRequestOf,
	exampleTagsOf,
	type AccessDenialRow,
	type AccessRole,
	type AccessRow,
	type SecretParameterArns,
	type StoreArns,
} from "./role-access-manifest.ts";

/** One condition key value the policy simulator is given, in the shape of the SimulatePrincipalPolicy `ContextEntries` parameter. */
export type SimulationContextEntry = {
	readonly ContextKeyName: string;
	readonly ContextKeyValues: readonly string[];
	readonly ContextKeyType: "string" | "stringList";
};

/** One question for the policy simulator: may this role perform this action on this resource, given these condition keys. */
export type SimulationCase = {
	readonly role: AccessRole;
	readonly description: string;
	readonly action: string;
	readonly resourceArn: string;
	readonly contextEntries: readonly SimulationContextEntry[];
	/** What the deployed role must answer; a case without it must be allowed. */
	readonly expectation?: "allowed" | "denied";
};

const SIMULATED_KEY_TYPES: Record<string, SimulationContextEntry["ContextKeyType"]> = {
	"dynamodb:LeadingKeys": "stringList",
	"s3:prefix": "string",
};

/**
 * The questions to put to the policy simulator for the rows of the manifest: each row's example request, with the role's
 * session tags as `aws:PrincipalTag/...` entries, and for each object read that may find the key missing a second question,
 * whether the role may list the bucket with no `s3:prefix` key, which decides between 404 and 403.
 *
 * @param rows The manifest rows.
 * @param arns The ARNs of the deployed stores.
 * @returns The cases, in manifest order.
 */
export function simulationCasesOf(rows: readonly AccessRow[], arns: StoreArns): SimulationCase[] {
	return rows.flatMap((row) => {
		const request = exampleRequestOf(row, arns);
		const tagEntries: SimulationContextEntry[] = Object.entries(exampleTagsOf(row.role)).map(([key, value]) => ({
			ContextKeyName: `aws:PrincipalTag/${key}`,
			ContextKeyValues: [value],
			ContextKeyType: "string",
		}));
		const keyEntries: SimulationContextEntry[] = Object.entries(request.contextKeys).map(([name, values]) => ({
			ContextKeyName: name,
			ContextKeyValues: values,
			ContextKeyType: SIMULATED_KEY_TYPES[name] ?? "stringList",
		}));
		const cases: SimulationCase[] = [
			{ role: row.role, description: describeRow(row), action: request.action, resourceArn: request.resourceArn, contextEntries: [...tagEntries, ...keyEntries] },
		];
		if (row.action === "s3:GetObject" && row.keyAlwaysExists !== true) {
			cases.push({
				role: row.role,
				description: `${describeRow(row)}, listing the bucket without a prefix so a missing key answers 404`,
				action: "s3:ListBucket",
				resourceArn: arns[row.store],
				contextEntries: tagEntries,
			});
		}
		return cases;
	});
}

/**
 * The questions for the denial rows of the manifest: each one asks whether a role may read a secret parameter and must be
 * answered with a denial, explicit or implicit.
 *
 * @param denials The denial rows.
 * @param arns The ARNs of the secret parameters of the deployed environment.
 * @returns The cases, in manifest order.
 */
export function denialSimulationCasesOf(denials: readonly AccessDenialRow[], arns: SecretParameterArns): SimulationCase[] {
	return denials.map((denial) => ({
		role: denial.role,
		description: `${denial.role} must be denied ${denial.action} on ${denial.parameter}`,
		action: denial.action,
		resourceArn: arns[denial.parameter],
		contextEntries: Object.entries(exampleTagsOf(denial.role)).map(([key, value]) => ({
			ContextKeyName: `aws:PrincipalTag/${key}`,
			ContextKeyValues: [value],
			ContextKeyType: "string" as const,
		})),
		expectation: "denied",
	}));
}

/** Cases that share a role, a resource and condition keys, so one simulator call answers all of their actions. */
export type SimulationGroup = {
	readonly role: AccessRole;
	readonly resourceArn: string;
	readonly contextEntries: readonly SimulationContextEntry[];
	readonly actions: readonly string[];
	readonly cases: readonly SimulationCase[];
};

/** One per-action evaluation as the simulator returns it. */
export type SimulationEvaluation = { readonly EvalActionName?: string; readonly EvalDecision?: string };

/**
 * Groups cases by role, resource ARN and context entries so the simulator is called once per group instead of once per case.
 *
 * @param cases The cases, in manifest order.
 * @returns The groups in first-seen order; each holds its distinct actions in first-seen order and all of its cases.
 */
export function simulationGroupsOf(cases: readonly SimulationCase[]): SimulationGroup[] {
	const groups = new Map<string, { role: AccessRole; resourceArn: string; contextEntries: readonly SimulationContextEntry[]; actions: string[]; cases: SimulationCase[] }>();
	for (const simulationCase of cases) {
		const key = JSON.stringify([simulationCase.role, simulationCase.resourceArn, simulationCase.contextEntries]);
		let group = groups.get(key);
		if (group === undefined) {
			group = { role: simulationCase.role, resourceArn: simulationCase.resourceArn, contextEntries: simulationCase.contextEntries, actions: [], cases: [] };
			groups.set(key, group);
		}
		if (!group.actions.includes(simulationCase.action)) group.actions.push(simulationCase.action);
		group.cases.push(simulationCase);
	}
	return [...groups.values()];
}

/**
 * Maps the per-action evaluations of one grouped simulator call back to the cases of the group.
 *
 * @param group The group that was simulated.
 * @param evaluations The evaluation results the simulator returned.
 * @returns One result per case, in the order of the group's cases.
 * @throws When an action of the group has no evaluation, which would otherwise hide a case.
 */
export function simulationResultsOf(group: SimulationGroup, evaluations: readonly SimulationEvaluation[]): SimulationResult[] {
	const decisions = new Map(evaluations.map((evaluation) => [evaluation.EvalActionName, evaluation.EvalDecision]));
	return group.cases.map((simulationCase) => {
		const decision = decisions.get(simulationCase.action);
		if (decision === undefined) throw new Error(`The policy simulator returned no evaluation for ${simulationCase.action} (${simulationCase.description}).`);
		return { simulationCase, decision };
	});
}

/** What the simulator decided for one case. */
export type SimulationResult = { readonly simulationCase: SimulationCase; readonly decision: string };

/** Whether the simulator answered as the case required: allowed for a case that must be allowed, any denial for one that must be denied. */
export function resultAsRequired(result: SimulationResult): boolean {
	return (result.simulationCase.expectation ?? "allowed") === "allowed" ? result.decision === "allowed" : result.decision !== "allowed";
}

/**
 * The one line an operator reads after a deploy.
 *
 * @param environment The environment name.
 * @param results The decisions.
 * @returns A line starting `PASS` when every case was answered as required and `FAIL` otherwise.
 */
export function simulationSummaryOf(environment: string, results: readonly SimulationResult[]): string {
	const mustAllow = results.filter((result) => (result.simulationCase.expectation ?? "allowed") === "allowed");
	const mustDeny = results.filter((result) => result.simulationCase.expectation === "denied");
	const refused = mustAllow.filter((result) => !resultAsRequired(result));
	const permitted = mustDeny.filter((result) => !resultAsRequired(result));
	const perRole = ACCESS_ROLES.map((role) => `${role} ${results.filter((result) => result.simulationCase.role === role).length}`).join(", ");
	const allowedPart = `${mustAllow.length - refused.length} of ${mustAllow.length} allowed`;
	const deniedPart = mustDeny.length === 0 ? "" : `, ${mustDeny.length - permitted.length} of ${mustDeny.length} denied as required`;
	const refusedPart = refused.length === 0 ? "" : `; denied: ${refused.map((result) => result.simulationCase.description).join("; ")}`;
	const permittedPart = permitted.length === 0 ? "" : `; wrongly allowed: ${permitted.map((result) => result.simulationCase.description).join("; ")}`;
	return `${refused.length + permitted.length === 0 ? "PASS" : "FAIL"} role access ${environment}: ${allowedPart}${deniedPart} (${perRole})${refusedPart}${permittedPart}`;
}
