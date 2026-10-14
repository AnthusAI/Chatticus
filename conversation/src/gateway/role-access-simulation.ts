import { ACCESS_ROLES, describeRow, exampleRequestOf, exampleTagsOf, type AccessRole, type AccessRow, type StoreArns } from "./role-access-manifest.ts";

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

/** What the simulator decided for one case. */
export type SimulationResult = { readonly simulationCase: SimulationCase; readonly decision: string };

/**
 * The one line an operator reads after a deploy.
 *
 * @param environment The environment name.
 * @param results The decisions.
 * @returns A line starting `PASS` when every case was allowed and `FAIL` otherwise.
 */
export function simulationSummaryOf(environment: string, results: readonly SimulationResult[]): string {
	const denied = results.filter((result) => result.decision !== "allowed");
	const perRole = ACCESS_ROLES.map((role) => `${role} ${results.filter((result) => result.simulationCase.role === role).length}`).join(", ");
	return `${denied.length === 0 ? "PASS" : "FAIL"} role access ${environment}: ${results.length - denied.length} of ${results.length} allowed (${perRole})${denied.length === 0 ? "" : `; denied: ${denied.map((result) => result.simulationCase.description).join("; ")}`}`;
}

