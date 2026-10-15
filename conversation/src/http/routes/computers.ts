import type { Context } from "hono";
import type { ComputerAction } from "../../domain/actions.ts";
import { computerForOrganization } from "../../domain/computers.ts";
import type { Computer } from "../../store/codecs/computer.ts";
import { type ParkDependencies, resumeWaitingTurn } from "../../turn/park.ts";
import { ComputerNotFoundError } from "../errors.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";
import { turnPayload } from "./turns.ts";

/** Everything the computer routes depend on. */
export interface ComputerRouteDependencies extends UserPrincipalDependencies {
	park: ParkDependencies;
}

/** One computer as the HTTP API renders it. */
export function computerPayload(computer: Computer): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		computer_id: computer.computerId,
		tenant_id: computer.tenantId,
		stopped: computer.stopped,
		policy: computer.policy,
		host_start_generation: computer.hostStartGeneration,
		model_ready: computer.modelReady,
		workspace_ready: computer.workspaceReady,
		browser_ready: computer.browserReady,
		snapshot_generation: computer.snapshotGeneration,
		disk_dirty: computer.diskDirty,
		hydrate_required: computer.hydrateRequired,
	};
	if (computer.browserUnavailable === true) payload.browser_unavailable = true;
	if (computer.snapshotUri !== undefined) payload.snapshot_uri = computer.snapshotUri;
	if (computer.snapshotChecksum !== undefined) payload.snapshot_checksum = computer.snapshotChecksum;
	if (computer.intendedHostWorkerId !== undefined) payload.intended_host_worker_id = computer.intendedHostWorkerId;
	return payload;
}

/** One action as the host reads it: what to run, where, and what it may touch. */
export function actionPayload(action: ComputerAction): Record<string, unknown> {
	return {
		action_id: action.actionId,
		turn_id: action.turnId,
		call_id: action.callId,
		tool_name: action.toolName,
		arguments: { ...action.arguments },
		gate: action.gate,
		envelope: { ...action.envelope },
		status: action.status,
		lease_expires_at: action.leaseExpiresAt === null ? null : action.leaseExpiresAt.toISOString(),
	};
}

async function readComputer(c: Context, deps: ComputerRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	try {
		return c.json(computerPayload(await computerForOrganization(pathParameter(c, "tenant_id"), deps)), 200);
	} catch (error) {
		if (error instanceof ComputerNotFoundError) {
			return c.json({ detail: "computer not found" }, 404);
		}
		throw error;
	}
}

/** GET /orgs/{tenant_id}/computer and /orgs/{tenant_id}/users/{user_id}/computer: the organization computer. */
export async function getComputerHandler(c: Context, deps: ComputerRouteDependencies): Promise<Response> {
	return readComputer(c, deps);
}

/**
 * POST /orgs/{tenant_id}/turns/{turn_id}/resume: send a waiting turn back to the run queue. 409 while the organization
 * computer is stopped, when the turn is not waiting, and when it has ended.
 */
export async function resumeTurnHandler(c: Context, deps: ComputerRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const turn = await resumeWaitingTurn(deps.park, pathParameter(c, "tenant_id"), pathParameter(c, "turn_id"));
	return c.json({ status: "ok", turn_id: turn.turnId, gate: turn.waitingFor ?? "", turn: turnPayload(turn) }, 200);
}
