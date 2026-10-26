import {
	describeRow,
	exampleKeyOf,
	exampleRequestOf,
	exampleTagsOf,
	type AccessRole,
	type AccessRow,
	type AccessStore,
	type StoreArns,
} from "../src/gateway/role-access-manifest.ts";
import type { RecordedAwsRequest } from "./aws-request-recorder.ts";
import { objectReadOutcome, policyAllows, type PolicyStatement } from "./iam-policy-evaluator.ts";

const RECORDED_DYNAMODB_ARN_PREFIX = "arn:aws:dynamodb:us-east-1:111122223333:table/";

/** The ARNs the cucumber scenarios judge the JSON policy files under: fixed names, because the files only need the ARN text. */
export const FIXED_STORE_ARNS: StoreArns = {
	messagingTable: `${RECORDED_DYNAMODB_ARN_PREFIX}messaging`,
	conversationsTable: `${RECORDED_DYNAMODB_ARN_PREFIX}conversations`,
	piSessionsBucket: "arn:aws:s3:::pi-sessions",
	snapshotBucket: "arn:aws:s3:::snapshots",
	channelEventBus: "arn:aws:events:us-east-1:111122223333:event-bus/default",
};

/**
 * The rows the policy of the role would not serve. A row fails when the evaluator denies its example request, or when it
 * reads an object that may be missing and the policy would answer 403 AccessDenied instead of 404 NoSuchKey because the
 * role cannot list the bucket without a prefix condition: the failure that took every computer start down on 2026-10-13
 * while the in-memory stores, which enforce no policy, let it through.
 *
 * @param rows The rows of one role.
 * @param statements The statements of the role's policy.
 * @param arns The ARNs of the stores the statements name.
 * @returns One sentence per failing row; empty when the policy serves them all.
 */
export function rowsTheRoleCannotServe(rows: readonly AccessRow[], statements: readonly PolicyStatement[], arns: StoreArns): string[] {
	const failures: string[] = [];
	for (const row of rows) {
		const tags = exampleTagsOf(row.role);
		if (!policyAllows(statements, tags, exampleRequestOf(row, arns))) {
			failures.push(`${describeRow(row)} is denied by the policy`);
			continue;
		}
		if (row.action === "s3:GetObject" && row.keyAlwaysExists !== true) {
			const outcome = objectReadOutcome(statements, tags, arns[row.store], exampleKeyOf(row), false);
			if (outcome !== "NoSuchKey") {
				failures.push(`${describeRow(row)} would answer 403 AccessDenied for a missing key, because the role may not list the bucket without a prefix condition`);
			}
		}
	}
	return failures;
}

/** Whether the row describes the request: same role, action, store, index use and key shape. */
function rowMatches(row: AccessRow, role: AccessRole, request: RecordedAwsRequest, store: AccessStore): boolean {
	if (row.role !== role || row.action !== request.action || row.store !== store) return false;
	if (request.service === "dynamodb" && (row.index === true) !== request.resourceArn.includes("/index/")) return false;
	if (request.keys.length === 0) return row.keyPattern === "";
	if (row.keyPattern === "") return false;
	const pattern = new RegExp(row.keyPattern);
	return request.keys.every((key) => pattern.test(key));
}

/**
 * The recorded requests of a role that the manifest does not describe, and the recorded reads of a missing object that
 * hit a row claiming its key always exists. Each is one sentence naming the role, the action and the key, ending in what
 * to do: add the row, then let the policy allow it.
 *
 * @param rows The whole manifest.
 * @param role The role that made the requests.
 * @param requests The recorded requests.
 * @param storeOf The store a recorded request went to, or null when it went to a store the scenario does not know.
 * @returns The distinct findings; empty when every request is described.
 */
export function requestsTheManifestDoesNotDescribe(
	rows: readonly AccessRow[],
	role: AccessRole,
	requests: readonly RecordedAwsRequest[],
	storeOf: (request: RecordedAwsRequest) => AccessStore | null,
): string[] {
	const findings = new Set<string>();
	for (const request of requests) {
		const store = storeOf(request);
		const shape = `${request.action} on ${store ?? `unknown store ${request.store}`} key ${request.keys.join(",") || "(none)"}`;
		const row = store === null ? undefined : rows.find((candidate) => rowMatches(candidate, role, request, store));
		if (row === undefined) {
			findings.add(`${role} made ${shape}, which role-access-manifest.json does not list: add a row for it, then make the role's policy allow it`);
			continue;
		}
		if (request.objectMissing === true && row.keyAlwaysExists === true) {
			findings.add(`${role} read a key that did not exist (${shape}), but its manifest row says the key always exists`);
		}
	}
	return [...findings];
}
