import type { PolicyStatement, SessionPolicyDocument } from "../src/gateway/session-policy.ts";

/** One request to an AWS service as IAM sees it: the action, the resource it names and the condition keys it carries. */
export type AuthorizedRequest = {
	readonly action: string;
	readonly resourceArn: string;
	readonly contextKeys: Readonly<Record<string, readonly string[]>>;
};

function matchesGlob(glob: string, value: string, caseInsensitive: boolean): boolean {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, caseInsensitive ? "is" : "s").test(value);
}

type ConditionOperator = { readonly forAllValues: boolean; readonly comparison: "StringEquals" | "StringLike" };

function parseOperator(name: string): ConditionOperator {
	const forAllValues = name.startsWith("ForAllValues:");
	const comparison = forAllValues ? name.slice("ForAllValues:".length) : name;
	if (comparison !== "StringEquals" && comparison !== "StringLike") {
		throw new Error(`The policy evaluator does not support the condition operator ${name}.`);
	}
	return { forAllValues, comparison };
}

function valueMatches(comparison: ConditionOperator["comparison"], allowed: readonly string[], value: string): boolean {
	return allowed.some((candidate) => (comparison === "StringEquals" ? candidate === value : matchesGlob(candidate, value, false)));
}

function conditionHolds(statement: PolicyStatement, request: AuthorizedRequest): boolean {
	for (const [operatorName, keys] of Object.entries(statement.Condition ?? {})) {
		const operator = parseOperator(operatorName);
		for (const [key, allowed] of Object.entries(keys)) {
			const values = request.contextKeys[key];
			if (values === undefined) {
				if (operator.forAllValues) continue;
				return false;
			}
			const check = (value: string): boolean => valueMatches(operator.comparison, allowed, value);
			const holds = operator.forAllValues ? values.every(check) : values.some(check);
			if (!holds) return false;
		}
	}
	return true;
}

/**
 * Whether a session policy allows one request, by the rules IAM applies to a policy of Allow statements: some statement
 * must name the action and the resource and have every condition true. The evaluator supports the `StringEquals` and
 * `StringLike` operators with or without the `ForAllValues:` prefix and refuses any other operator, so a policy can
 * never pass by a condition the evaluator did not understand. A `ForAllValues` condition on a key the request does not
 * carry is true, as in IAM.
 *
 * @param policy The session policy.
 * @param request The request.
 * @returns True when some statement allows the request.
 */
export function policyAllows(policy: SessionPolicyDocument, request: AuthorizedRequest): boolean {
	return policy.Statement.some(
		(statement) =>
			statement.Effect === "Allow" &&
			statement.Action.some((action) => matchesGlob(action, request.action, true)) &&
			statement.Resource.some((resource) => matchesGlob(resource, request.resourceArn, false)) &&
			conditionHolds(statement, request),
	);
}
