import type {
	CapabilityPolicy,
	PolicyBrowserContext,
	ApprovalDecision,
} from "./capability-policy.ts";
import { EgressClass, RequestedCapability } from "./capability-policy.ts";
import type {
	ApprovalBindingGate,
	ApprovedOperation,
	BoundExecutionResult,
	StructuredConsequentialOperation,
} from "./approval-binding.ts";
import { MemberStanding, requestExceedsMemberStanding } from "./authorization-ceiling.ts";
import type { AutoReviewRule } from "./models.ts";
import { resolveUnattendedGatedAction, type OvernightGatedResult } from "./overnight.ts";

export { MemberStanding };

export const POLICY_KERNEL_TENANT = "policy-tenant";
export const POLICY_KERNEL_TURN = "policy-turn";

export const MEMBER_STANDING_DENIAL = "exceeds member authority standing";

/**
 * A model-requested operation was blocked at a system sink.
 */
export class CapabilitySinkDenied extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CapabilitySinkDenied";
	}
}

/**
 * A model-requested operation requires immutable human approval.
 */
export class CapabilitySinkApprovalRequired extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CapabilitySinkApprovalRequired";
	}
}

/**
 * Build one capability request from a structured consequential action.
 */
export function structuredActionRequest(
	actionType: string,
	arguments_: Record<string, string>,
): RequestedCapability {
	const recipient = arguments_["recipient"] ?? arguments_["destination"] ?? undefined;
	let egressClass: string | null = null;
	if (actionType === "send") {
		egressClass = "structured_send";
	} else if (["publish", "purchase", "delete", "production_change"].includes(actionType)) {
		egressClass = "file_transfer";
	}
	return new RequestedCapability(
		actionType,
		arguments_["origin"] ?? undefined,
		recipient,
		arguments_["file_path"] ?? undefined,
		egressClass,
	);
}

/**
 * Record and raise when a request exceeds the acting member's standing.
 */
export function denyIfExceedsMemberStanding(
	policy: CapabilityPolicy,
	request: RequestedCapability,
	memberStanding: MemberStanding,
	{ structuredArguments }: { structuredArguments?: Record<string, string> | null } = {},
): void {
	if (requestExceedsMemberStanding(request, memberStanding, structuredArguments)) {
		policy["_deny"](MEMBER_STANDING_DENIAL, request);
		throw new CapabilitySinkDenied(MEMBER_STANDING_DENIAL);
	}
}

/**
 * Raise when standing, the policy, or approval requirements block a request.
 */
export function requireAllow(
	policy: CapabilityPolicy,
	request: RequestedCapability,
	memberStanding: MemberStanding,
	{ structuredArguments }: { structuredArguments?: Record<string, string> | null } = {},
): void {
	denyIfExceedsMemberStanding(policy, request, memberStanding, { structuredArguments });
	const decision = policy.evaluate(request);
	if (decision === "DENY") {
		const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
		throw new CapabilitySinkDenied(reason);
	}
	if (decision === "REQUIRE_APPROVAL") {
		throw new CapabilitySinkApprovalRequired("immutable approval required");
	}
}

/**
 * Raise when standing or the task grant denies the request.
 */
export function requireGranted(
	policy: CapabilityPolicy,
	request: RequestedCapability,
	memberStanding: MemberStanding,
	{ structuredArguments }: { structuredArguments?: Record<string, string> | null } = {},
): void {
	denyIfExceedsMemberStanding(policy, request, memberStanding, { structuredArguments });
	const decision = policy.evaluate(request);
	if (decision === "DENY") {
		const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
		throw new CapabilitySinkDenied(reason);
	}
}

/**
 * Authorize a workspace read at the file sink.
 */
export function gatedReadWorkspace(
	policy: CapabilityPolicy,
	path: string,
	memberStanding: MemberStanding,
): void {
	requireAllow(
		policy,
		new RequestedCapability(
			"read_workspace",
			undefined,
			undefined,
			path,
			"approved_origin_fetch",
		),
		memberStanding,
	);
}

/**
 * Authorize a workspace write at the file sink.
 */
export function gatedWriteWorkspace(
	policy: CapabilityPolicy,
	path: string,
	memberStanding: MemberStanding,
): void {
	requireAllow(
		policy,
		new RequestedCapability(
			"write_workspace",
			undefined,
			undefined,
			path,
			undefined,
		),
		memberStanding,
	);
}

/**
 * Authorize one granted shell command at the terminal sink.
 */
export function gatedRunTerminal(
	policy: CapabilityPolicy,
	command: string,
	cwd: string,
	memberStanding: MemberStanding,
): void {
	requireAllow(
		policy,
		new RequestedCapability(
			"run_terminal",
			undefined,
			undefined,
			cwd,
			undefined,
		),
		memberStanding,
	);
}

/**
 * Authorize opening or fetching one origin.
 */
export function gatedBrowseOrigin(
	policy: CapabilityPolicy,
	url: string,
	memberStanding: MemberStanding,
): void {
	requireAllow(
		policy,
		new RequestedCapability(
			"browse",
			url,
			undefined,
			undefined,
			"approved_origin_fetch",
		),
		memberStanding,
	);
}

/**
 * Authorize binding one structured send at the connector sink.
 */
export function gatedStructuredSend(
	policy: CapabilityPolicy,
	recipient: string,
	payload: string,
	memberStanding: MemberStanding,
): void {
	requireGranted(
		policy,
		new RequestedCapability(
			"send",
			undefined,
			recipient,
			undefined,
			"structured_send",
		),
		memberStanding,
		{ structuredArguments: { recipient, body: payload } },
	);
	policy.bindConnector("send", recipient, payload);
}

/**
 * Open research browsing in an isolated context.
 */
export function openUntrustedBrowserContext(
	policy: CapabilityPolicy,
	pageUrl: string,
	memberStanding: MemberStanding,
): PolicyBrowserContext {
	gatedBrowseOrigin(policy, pageUrl, memberStanding);
	return policy.openUntrusted(pageUrl);
}

/**
 * Open a named privileged session in its own partition.
 */
export function openPrivilegedBrowserContext(
	policy: CapabilityPolicy,
	pageUrl: string,
	service: string,
	memberStanding: MemberStanding,
): PolicyBrowserContext {
	gatedBrowseOrigin(policy, pageUrl, memberStanding);
	return policy.openPrivileged(pageUrl, service);
}

/**
 * Return a session secret only when the active context may use it.
 */
export function gatedBrowserSession(
	policy: CapabilityPolicy,
	context: PolicyBrowserContext,
	service: string,
	session?: string | null,
): string | null {
	if (session !== null && session !== undefined && !policy.contextMayUse(context, service)) {
		throw new CapabilitySinkDenied(`context cannot use browser session ${JSON.stringify(service)}`);
	}
	if (session) {
		return session;
	}
	const credential = policy.credentials.get(service);
	if (credential === undefined || credential.kind !== "browser_session") {
		return null;
	}
	if (!policy.contextMayUse(context, service)) {
		return null;
	}
	return credential.value;
}

const CHANNEL_BROWSER = "browser";
const CONSEQUENTIAL_ACTION_TYPES = ["send", "publish", "purchase", "delete", "production_change"];

/**
 * Evaluate binding controls for one authenticated browser action.
 */
export function attemptAuthenticatedBrowserActionAtSink(
	policy: CapabilityPolicy,
	action: string,
	{ structuredConnector = false, takeoverControl = false } = {},
): OvernightGatedResult {
	if (structuredConnector || takeoverControl) {
		throw new Error("binding control is present; this path is for unbound actions");
	}
	policy.requiredBindingForBrowserAction(action);
	let result = policy.last_overnight;
	if (result !== null) {
		return result;
	}
	const actionType = action;
	if (!CONSEQUENTIAL_ACTION_TYPES.includes(actionType)) {
		return {
			executed: true,
			turn_status: "completed",
			reason: null,
			completion_evidence: null,
			retried_unattended: false,
		};
	}
	return {
		executed: false,
		turn_status: "blocked",
		reason: "user_controlled_completion_required",
		completion_evidence: null,
		retried_unattended: false,
	};
}

/**
 * Stop or pre-authorize a consequential action with no screen.
 */
export function resolveUnattendedGatedActionAtSink(
	policy: CapabilityPolicy,
	{
		actionType,
		arguments: arguments_,
		channel,
		rules,
		tenantId,
		memberStanding,
		userId,
		completionEvidence = "system-accepted",
	}: {
		actionType: string;
		arguments: Record<string, string>;
		channel: string;
		rules: readonly AutoReviewRule[];
		tenantId: string;
		memberStanding: MemberStanding;
		userId?: string | null;
		completionEvidence?: string;
	},
): OvernightGatedResult {
	const request = structuredActionRequest(actionType, arguments_);
	try {
		denyIfExceedsMemberStanding(
			policy,
			request,
			memberStanding,
			{ structuredArguments: arguments_ },
		);
	} catch (error) {
		if (error instanceof CapabilitySinkDenied) {
			return {
				executed: false,
				turn_status: "blocked",
				reason: error.message,
				completion_evidence: null,
				retried_unattended: false,
			};
		}
		throw error;
	}
	if (policy.grant === null) {
		if (CONSEQUENTIAL_ACTION_TYPES.includes(actionType)) {
			policy.evaluate(request);
			return {
				executed: false,
				turn_status: "blocked",
				reason: "no task grant",
				completion_evidence: null,
				retried_unattended: false,
			};
		}
	} else {
		const decision = policy.evaluate(request);
		if (decision === "DENY") {
			const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
			return {
				executed: false,
				turn_status: "blocked",
				reason,
				completion_evidence: null,
				retried_unattended: false,
			};
		}
	}
	if (channel === CHANNEL_BROWSER && CONSEQUENTIAL_ACTION_TYPES.includes(actionType)) {
		return attemptAuthenticatedBrowserActionAtSink(policy, actionType);
	}
	return resolveUnattendedGatedAction({
		actionType,
		arguments: arguments_,
		channel,
		rules,
		tenantId,
		userId,
		completionEvidence,
	});
}

/**
 * Execute one approved connector operation after grant and binding checks.
 */
export async function executeApprovedOperationAtSink(
	policy: CapabilityPolicy,
	gate: ApprovalBindingGate,
	approval: ApprovedOperation,
	attempted: StructuredConsequentialOperation,
	completionEvidence: string,
	memberStanding: MemberStanding,
): Promise<BoundExecutionResult> {
	const request = new RequestedCapability(
		attempted.actionType,
		undefined,
		attempted.destination,
		undefined,
		EgressClass.StructuredSend,
	);
	const structuredArguments = {
		destination: attempted.destination,
		payload: attempted.payload,
	};
	try {
		requireGranted(policy, request, memberStanding, { structuredArguments });
	} catch (error) {
		if (error instanceof CapabilitySinkDenied) {
			return {
				executed: false,
				reason: error.message,
				completionEvidence: null,
				requiresNewApproval: true,
			};
		}
		throw error;
	}
	const bindingResult = await gate.executeApprovedOperation(approval, attempted, completionEvidence);
	if (bindingResult.executed) {
		policy.bindConnector(attempted.actionType, attempted.destination, attempted.payload);
		policy.approveBoundOperation();
		policy.executeBoundConnector(completionEvidence);
	}
	return bindingResult;
}

/**
 * Return the last recorded binding control as a string, if any.
 */
export function bindingControlValue(policy: CapabilityPolicy): string | null {
	if (policy.last_binding === null) {
		return null;
	}
	return policy.last_binding;
}
