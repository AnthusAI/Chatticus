import { readFileSync } from "node:fs";

/** One Allow statement of an IAM identity policy, with policy variables still in its text. */
export type PolicyStatement = {
	readonly Sid?: string;
	readonly Effect: "Allow";
	readonly Action: readonly string[];
	readonly Resource: readonly string[];
	readonly Condition?: Record<string, Record<string, readonly string[]>>;
};

/** The ARNs the shared policy file leaves as placeholders, because they are known only when the stores exist. */
export type OwnerRolePolicyResources = {
	readonly piSessionsBucketArn: string;
	readonly snapshotBucketArn: string;
	readonly conversationsTableArn: string;
	readonly messagingTableArn: string;
};

/** The file of the owner role's permission statements; the CDK stack reads this same file. */
export const OWNER_ROLE_POLICY_FILE = new URL("../src/gateway/owner-role-policy.json", import.meta.url);

/**
 * The statements of the computer owner role's permission policy, read from the same file the CDK stack deploys, with the
 * store ARNs filled in. The `${aws:PrincipalTag/...}` policy variables stay in the text; `policyAllows` substitutes them.
 *
 * @param resources The ARNs of the stores.
 * @returns The statements.
 */
export function ownerRolePolicyStatements(resources: OwnerRolePolicyResources): PolicyStatement[] {
	const text = readFileSync(OWNER_ROLE_POLICY_FILE, "utf8")
		.replaceAll("{{piSessionsBucketArn}}", resources.piSessionsBucketArn)
		.replaceAll("{{snapshotBucketArn}}", resources.snapshotBucketArn)
		.replaceAll("{{conversationsTableArn}}", resources.conversationsTableArn)
		.replaceAll("{{messagingTableArn}}", resources.messagingTableArn);
	return (JSON.parse(text) as { statements: PolicyStatement[] }).statements;
}

/** The session tags of the assumed role, by tag key. */
export type SessionTagValues = Readonly<Record<string, string>>;

/** One request to an AWS service as IAM sees it: the action, the resource it names and the condition keys it carries. */
export type AuthorizedRequest = {
	readonly action: string;
	readonly resourceArn: string;
	readonly contextKeys: Readonly<Record<string, readonly string[]>>;
};

const POLICY_VARIABLE = /\$\{aws:PrincipalTag\/([A-Za-z0-9_.:/=+@-]+)\}/g;

function substituteTags(text: string, tags: SessionTagValues): string {
	return text.replace(POLICY_VARIABLE, (_match, key: string) => {
		const value = tags[key];
		if (value === undefined) throw new Error(`The policy names the session tag ${key}, which the session does not carry.`);
		return value;
	});
}

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

function conditionHolds(statement: PolicyStatement, request: AuthorizedRequest, tags: SessionTagValues): boolean {
	for (const [operatorName, keys] of Object.entries(statement.Condition ?? {})) {
		const operator = parseOperator(operatorName);
		for (const [key, rawAllowed] of Object.entries(keys)) {
			const allowed = rawAllowed.map((value) => substituteTags(value, tags));
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
 * Whether the role's policy allows one request for a session with the given tags, by the rules IAM applies to a policy of
 * Allow statements: some statement must name the action and the resource and have every condition true, after the
 * `${aws:PrincipalTag/...}` variables are replaced by the session's tag values. The evaluator supports the `StringEquals`
 * and `StringLike` operators with or without the `ForAllValues:` prefix and refuses any other operator, so a policy can
 * never pass by a condition the evaluator did not understand. A `ForAllValues` condition on a key the request does not
 * carry is true, as in IAM, which is why a statement must never name an action that can omit the key (Scan).
 *
 * @param statements The role's permission statements.
 * @param tags The session tags the role was assumed with.
 * @param request The request.
 * @returns True when some statement allows the request.
 */
export function policyAllows(statements: readonly PolicyStatement[], tags: SessionTagValues, request: AuthorizedRequest): boolean {
	return statements.some(
		(statement) =>
			statement.Effect === "Allow" &&
			statement.Action.some((action) => matchesGlob(action, request.action, true)) &&
			statement.Resource.some((resource) => matchesGlob(substituteTags(resource, tags), request.resourceArn, false)) &&
			conditionHolds(statement, request, tags),
	);
}
