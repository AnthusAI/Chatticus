/**
 * The tool gate of a turn: every model tool call is checked against the turn's closed grant, the acting member's
 * standing and the approval requirement before the tool runs.
 *
 * Ported from python/src/chatticus/control_plane.py lines 1604-1790 (requested_capability_for_model_tool,
 * evaluate_model_tool_request, record_model_gated_tool_denied, deny_model_tool_request) and
 * python/src/chatticus/worker/tool_dispatch.py. The Python worker called HTTP routes for a verdict and journaled the
 * denial itself; here the gate is a pi-durable `beforeTool` hook. A blocked call never reaches `execute`: the model
 * sees the tool result "Tool call blocked: <reason>" and the executor's event listener journals the `tool.call` and
 * `tool.result` events like any other tool, so the denial is one result in one place.
 */

import { defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { TASK_TOOL_NAME } from "./task-tool.ts";
import { MemberStandingRequiredError } from "../http/errors.ts";
import {
	CapabilitySinkApprovalRequired,
	CapabilitySinkDenied,
	structuredActionRequest,
	requireAllow,
} from "../policy/sinks.ts";
import {
	CapabilityPolicy,
	EgressClass,
	RequestedCapability,
	type TaskCapabilityGrant,
} from "../policy/capability-policy.ts";
import type { MemberStanding } from "../policy/authorization-ceiling.ts";
import { CONSEQUENTIAL_ACTION_TYPES } from "../policy/models.ts";
import { stringArguments } from "./computer-tools.ts";

/** What the gate reads about the turn it guards. */
export type ToolGateDependencies = {
	readonly now: () => Date;
	/** The turn's grant as it is now, read for every call so a member's replacement applies to the next call. */
	readonly readGrant: () => Promise<TaskCapabilityGrant | null>;
	/** The standing of the member who posted the turn's prompt, for one consequential action type or none. */
	readonly resolveStanding: (actionType: string | null) => Promise<MemberStanding>;
};

/** The gate's answer for one call. */
export type ToolGateVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** The reason the gate gives when a consequential call needs a human's approval of its exact arguments. */
export const APPROVAL_REQUIRED_REASON = "immutable approval required";

/**
 * Map one model tool call to the capability it asks for.
 *
 * @param toolName The tool the model called.
 * @param arguments_ The call's arguments, all strings.
 * @returns The requested capability.
 */
export function requestedCapabilityForModelTool(
	toolName: string,
	arguments_: Readonly<Record<string, string>>,
): RequestedCapability {
	if (toolName === "read_workspace") {
		return new RequestedCapability(toolName, undefined, undefined, arguments_["path"], EgressClass.ApprovedOriginFetch);
	}
	if (toolName === "write_workspace" || toolName === "edit_workspace") {
		return new RequestedCapability(toolName, undefined, undefined, arguments_["path"]);
	}
	if (toolName === "browse") {
		return new RequestedCapability(toolName, arguments_["url"], undefined, undefined, EgressClass.ApprovedOriginFetch);
	}
	if (toolName === "run_terminal") {
		const cwd = (arguments_["cwd"] ?? "/workspace").trim() || "/workspace";
		return new RequestedCapability(toolName, undefined, undefined, cwd);
	}
	if (CONSEQUENTIAL_ACTION_TYPES.has(toolName)) {
		return structuredActionRequest(toolName, { ...arguments_ });
	}
	return new RequestedCapability(toolName);
}

/**
 * Decide one model tool call: allowed, or denied with the reason a member can read.
 *
 * @param deps The turn's grant and standing.
 * @param toolName The tool the model called.
 * @param arguments_ The call's arguments, all strings.
 * @returns The verdict. A denial never contains session secrets: the reason names the tool, origin, path or recipient
 * the model itself asked for.
 */
export async function evaluateModelToolRequest(
	deps: ToolGateDependencies,
	toolName: string,
	arguments_: Readonly<Record<string, string>>,
): Promise<ToolGateVerdict> {
	const consequential = CONSEQUENTIAL_ACTION_TYPES.has(toolName);
	const policy = new CapabilityPolicy(deps.now);
	const grant = await deps.readGrant();
	if (grant !== null) {
		policy.setGrant(grant);
	}
	try {
		requireAllow(
			policy,
			requestedCapabilityForModelTool(toolName, arguments_),
			await deps.resolveStanding(consequential ? toolName : null),
			{ structuredArguments: consequential ? { ...arguments_ } : null },
		);
	} catch (error) {
		if (error instanceof CapabilitySinkApprovalRequired) {
			return { allowed: false, reason: APPROVAL_REQUIRED_REASON };
		}
		if (error instanceof CapabilitySinkDenied || error instanceof MemberStandingRequiredError) {
			return { allowed: false, reason: error.message };
		}
		throw error;
	}
	return { allowed: true };
}

/**
 * Tools that are not capability tools: they touch only the organization's own durable records, never the computer, the
 * network or a recipient, so they need no grant. The Python worker dispatched the task tool before the gated tools.
 */
export const UNGATED_TOOL_NAMES: ReadonlySet<string> = new Set([TASK_TOOL_NAME]);

/**
 * The gate as an extension: a `beforeTool` hook on pi-durable's tool task. The hook sees the call after Pi has validated
 * it against the tool's schema and before any intent is recorded, so a blocked call leaves no trace of having started.
 * Registered once for every tool the model has, whichever extension defines it.
 *
 * @param deps The turn's grant and standing.
 * @returns The extension to install.
 */
export function toolGateExtension(deps: ToolGateDependencies): Extension {
	return defineExtension({
		name: "chatticus-tool-gate",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call) => {
					if (UNGATED_TOOL_NAMES.has(call.name)) return undefined;
					const verdict = await evaluateModelToolRequest(deps, call.name, stringArguments(call.arguments));
					return verdict.allowed ? undefined : { block: verdict.reason };
				},
			}),
		],
	});
}
