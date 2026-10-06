/**
 * The durable computer action: the record that answers "was a parked tool call ever run?".
 *
 * Replaces the in-memory escalation dictionary of python/src/chatticus/control_plane.py (`prepare_computer_tool`,
 * `escalation_for`, `commit_pending_computer_tool`, `execute_pending_computer_action`, `commit_computer_tool_result`,
 * `unresolved_computer_actions`, `expire_orphaned_computer_claims`). An action is created the first time a computer tool
 * call of a turn is made, keyed by the Pi tool call id. The host claims it under a lease, runs it, and posts a result;
 * a resumed turn finds the result by call id and never runs the tool twice.
 */

import type { Clock, IdSource } from "../http/app.ts";
import { ComputerActionNotClaimedError, ComputerActionNotFoundError } from "../http/errors.ts";
import type { ActionEnvelope, ComputerAction } from "../store/codecs/action.ts";
import { pythonRepr } from "./bots.ts";

export { ComputerActionNotClaimedError, ComputerActionNotFoundError };
export type { ActionEnvelope, ComputerAction };

/** Seconds a host holds an action before another host may take it; the same as the turn attempt lease. */
export const ACTION_LEASE_SECONDS = 60;

/** The readiness gate of the computer's workspace and terminal. */
export const WORKSPACE_GATE = "workspace";

/** The readiness gate of the computer's browser. */
export const BROWSER_GATE = "browser";

/** What the model reads when a host was lost while it ran a tool that cannot safely run again. */
export const INTERRUPTED_ACTION_RESULT = "The computer was lost while this tool ran, and it may have partially run.";

/** The computer tools, which are the tools that become actions. */
export const COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read_workspace",
	"write_workspace",
	"run_terminal",
	"browse",
	"request_computer_capability",
]);

/**
 * The readiness gate one computer tool needs. Ported from python/src/chatticus/computer_capabilities.py.
 *
 * @param toolName A computer tool.
 * @returns `browser` for the browser tools and capability requests, `workspace` for everything else.
 */
export function gateForComputerTool(toolName: string): string {
	return toolName === "browse" || toolName === "request_computer_capability" ? BROWSER_GATE : WORKSPACE_GATE;
}

/**
 * What the host may do for one tool call, and whether it is harmless to run twice. Reads, page loads and capability
 * requests are; writes and terminal commands are not.
 *
 * @param toolName A computer tool.
 * @param arguments_ The call's arguments.
 * @returns The envelope stored on the action.
 */
export function envelopeForCall(toolName: string, arguments_: Readonly<Record<string, string>>): ActionEnvelope {
	const idempotent = toolName === "read_workspace" || toolName === "browse" || toolName === "request_computer_capability";
	return {
		tool: toolName,
		idempotent,
		...(arguments_["path"] === undefined ? {} : { path: arguments_["path"] }),
		...(toolName === "run_terminal" ? { cwd: (arguments_["cwd"] ?? "/workspace").trim() || "/workspace" } : {}),
		...(arguments_["url"] === undefined ? {} : { origin: arguments_["url"] }),
	};
}

/** The conditional writes of the computer action items; the Messaging table implements them. */
export interface ComputerActionStore {
	/**
	 * Store a new action and the index item that finds it by call id, in one transaction.
	 *
	 * @returns The stored action and whether this call created it; an action already stored for the call id is returned
	 * unchanged.
	 */
	createIfAbsent(action: ComputerAction): Promise<{ action: ComputerAction; created: boolean }>;
	/** The action of one tool call of a turn, or null when none was created. */
	getByCall(tenantId: string, turnId: string, callId: string): Promise<ComputerAction | null>;
	/** One action, or null when it does not exist. */
	get(tenantId: string, actionId: string): Promise<ComputerAction | null>;
	/** Every action of the organization that is not done, oldest first. */
	listOpen(tenantId: string): Promise<ComputerAction[]>;
	/** Every action of one turn, oldest first. */
	listForTurn(tenantId: string, turnId: string): Promise<ComputerAction[]>;
	/**
	 * Take a requested action under a lease.
	 *
	 * @returns The claimed action, or null when it was no longer requested.
	 */
	claim(request: { tenantId: string; actionId: string; workerId: string; leaseExpiresAt: Date }): Promise<ComputerAction | null>;
	/**
	 * Answer an action. With `workerId` only that worker's claim may answer it; with null the control plane answers it on
	 * its own account (a lease that ran out, or work the spend ceiling stopped), and any action that is not done may be.
	 *
	 * @returns The action after the write, or null when the condition did not hold.
	 */
	complete(request: {
		tenantId: string;
		actionId: string;
		workerId: string | null;
		result: string;
		resultIsError: boolean;
		now: Date;
	}): Promise<ComputerAction | null>;
	/** Return a claimed action whose lease ran out to requested; null when it was not claimed any more. */
	release(tenantId: string, actionId: string): Promise<ComputerAction | null>;
}

/** What the action functions need. */
export type ActionDependencies = {
	readonly actions: ComputerActionStore;
	readonly clock: Clock;
	readonly ids: IdSource;
};

const addSeconds = (moment: Date, seconds: number): Date => new Date(moment.getTime() + seconds * 1000);

/** What creating an action needs to know about the call. */
export type ActionRequest = {
	readonly tenantId: string;
	readonly computerId: string;
	readonly turnId: string;
	readonly channelId: string;
	readonly botId: string;
	readonly userId: string | null;
	readonly callId: string;
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, string>>;
};

/**
 * Record that a turn asked its computer to run a tool. Asking twice with the same call id returns the first action, so a
 * resumed turn that reaches the same call never makes a second one.
 *
 * @param deps Action store, clock and identifiers.
 * @param request The call.
 * @returns The action, as stored.
 */
export async function requestComputerAction(deps: ActionDependencies, request: ActionRequest): Promise<ComputerAction> {
	const proposed: ComputerAction = {
		actionId: deps.ids.next(),
		tenantId: request.tenantId,
		computerId: request.computerId,
		turnId: request.turnId,
		channelId: request.channelId,
		botId: request.botId,
		userId: request.userId,
		callId: request.callId,
		toolName: request.toolName,
		arguments: { ...request.arguments },
		gate: gateForComputerTool(request.toolName),
		envelope: envelopeForCall(request.toolName, request.arguments),
		status: "requested",
		claimedBy: null,
		leaseExpiresAt: null,
		result: null,
		resultIsError: false,
		createdAt: deps.clock.now(),
		completedAt: null,
	};
	return (await deps.actions.createIfAbsent(proposed)).action;
}

/**
 * The action of one tool call of a turn, which a tool looks up before it parks.
 *
 * @returns The action, or null when the call has none yet.
 */
export async function computerActionForCall(
	deps: Pick<ActionDependencies, "actions">,
	tenantId: string,
	turnId: string,
	callId: string,
): Promise<ComputerAction | null> {
	return deps.actions.getByCall(tenantId, turnId, callId);
}

/**
 * Hand the next open action of the organization to a host, or none. Hosts take one action at a time: while another
 * worker holds an unexpired lease the answer is none, and a worker that asks again for an action it already holds gets
 * that action back.
 *
 * @param deps Action store and clock.
 * @param tenantId Organization.
 * @param workerId The host asking.
 * @returns The claimed action, or null when there is nothing for this worker.
 */
export async function claimNextComputerAction(
	deps: Pick<ActionDependencies, "actions" | "clock">,
	tenantId: string,
	workerId: string,
): Promise<ComputerAction | null> {
	const now = deps.clock.now();
	const open = await deps.actions.listOpen(tenantId);
	for (const action of open) {
		if (action.status !== "claimed" || action.leaseExpiresAt === null || action.leaseExpiresAt.getTime() <= now.getTime()) continue;
		return action.claimedBy === workerId ? action : null;
	}
	for (const action of open) {
		if (action.status !== "requested") continue;
		const claimed = await deps.actions.claim({
			tenantId,
			actionId: action.actionId,
			workerId,
			leaseExpiresAt: addSeconds(now, ACTION_LEASE_SECONDS),
		});
		if (claimed !== null) return claimed;
	}
	return null;
}

/**
 * Record what the host did. The first answer wins: posting again for an action that is already done returns the stored
 * action unchanged.
 *
 * @param deps Action store and clock.
 * @param tenantId Organization.
 * @param actionId The action.
 * @param workerId The host that claimed it.
 * @param answer The tool's text, and whether it is an error.
 * @returns The action after the answer, and whether this call recorded it.
 * @throws ComputerActionNotFoundError If the action does not exist.
 * @throws ComputerActionNotClaimedError If another worker holds the action, or nobody does.
 */
export async function completeComputerAction(
	deps: Pick<ActionDependencies, "actions" | "clock">,
	tenantId: string,
	actionId: string,
	workerId: string,
	answer: { readonly result: string; readonly isError: boolean },
): Promise<{ action: ComputerAction; recorded: boolean }> {
	const existing = await deps.actions.get(tenantId, actionId);
	if (existing === null) {
		throw new ComputerActionNotFoundError(`Computer action ${pythonRepr(actionId)} does not exist.`);
	}
	if (existing.status === "done") return { action: existing, recorded: false };
	const done = await deps.actions.complete({
		tenantId,
		actionId,
		workerId,
		result: answer.result,
		resultIsError: answer.isError,
		now: deps.clock.now(),
	});
	if (done === null) {
		const current = await deps.actions.get(tenantId, actionId);
		if (current?.status === "done") return { action: current, recorded: false };
		throw new ComputerActionNotClaimedError(
			`Computer action ${pythonRepr(actionId)} is not claimed by worker ${pythonRepr(workerId)}.`,
		);
	}
	return { action: done, recorded: true };
}

/**
 * Settle the actions whose host vanished: a claimed action whose lease ran out goes back to requested when running it
 * twice is harmless, and is answered with an interrupted error when it is not, so the turn resumes and the model is told.
 *
 * @param deps Action store and clock.
 * @param tenantId Organization.
 * @returns The actions this call changed, in their new state.
 */
export async function expireLostComputerActions(
	deps: Pick<ActionDependencies, "actions" | "clock">,
	tenantId: string,
): Promise<ComputerAction[]> {
	const now = deps.clock.now();
	const changed: ComputerAction[] = [];
	for (const action of await deps.actions.listOpen(tenantId)) {
		if (action.status !== "claimed" || action.leaseExpiresAt === null || action.leaseExpiresAt.getTime() > now.getTime()) continue;
		const settled = action.envelope.idempotent
			? await deps.actions.release(tenantId, action.actionId)
			: await deps.actions.complete({
					tenantId,
					actionId: action.actionId,
					workerId: null,
					result: INTERRUPTED_ACTION_RESULT,
					resultIsError: true,
					now,
				});
		if (settled !== null) changed.push(settled);
	}
	return changed;
}

/**
 * Answer an action on the control plane's own account, whatever its state, because the work behind it must not run any
 * more (the spend ceiling) or cannot be known to have run. An action that is already done is left as it is.
 *
 * @param deps Action store and clock.
 * @param action The action.
 * @param answer The text the tool call answers with, and whether it is an error.
 * @returns The action after the answer, or null when it was already done.
 */
export async function answerComputerActionOnOwnAccount(
	deps: Pick<ActionDependencies, "actions" | "clock">,
	action: ComputerAction,
	answer: { readonly result: string; readonly isError: boolean },
): Promise<ComputerAction | null> {
	return deps.actions.complete({
		tenantId: action.tenantId,
		actionId: action.actionId,
		workerId: null,
		result: answer.result,
		resultIsError: answer.isError,
		now: deps.clock.now(),
	});
}
