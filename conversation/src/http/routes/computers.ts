import type { Context } from "hono";
import { enforceWorkerPrincipal } from "../../auth/worker-principal.ts";
import { StorePrincipalDirectory } from "../../auth/store-principal-directory.ts";
import { claimNextComputerAction, completeComputerAction, type ComputerAction } from "../../domain/actions.ts";
import { computerForOrganization } from "../../domain/computers.ts";
import type { Computer } from "../../store/codecs/computer.ts";
import { type ParkDependencies, actionDependenciesOf, resumeTurnForAction, resumeWaitingTurn } from "../../turn/park.ts";
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

/**
 * POST /orgs/{tenant_id}/host/actions/claim: the host asks for the next computer action of the organization. The answer
 * holds the action under a lease, or `action: null` when nothing is waiting for this worker.
 */
export async function claimActionHandler(c: Context, deps: ComputerRouteDependencies): Promise<Response> {
	const tenantId = pathParameter(c, "tenant_id");
	const principal = await enforceWorkerPrincipal(c.req.raw, tenantId, new StorePrincipalDirectory(deps.store));
	const action = await claimNextComputerAction(actionDependenciesOf(deps.park), tenantId, principal.workerId as string);
	return c.json({ action: action === null ? null : actionPayload(action) }, 200);
}

/**
 * POST /orgs/{tenant_id}/host/actions/{action_id}/result: the host posts what its tool did. The first result wins; the
 * turn that was parked on the action resumes on the next owner, which finds this result by call id.
 */
export async function postActionResultHandler(c: Context, deps: ComputerRouteDependencies): Promise<Response> {
	const tenantId = pathParameter(c, "tenant_id");
	const principal = await enforceWorkerPrincipal(c.req.raw, tenantId, new StorePrincipalDirectory(deps.store));
	const body = (await c.req.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
	if (body === null || typeof body.result !== "string") {
		return c.json({ detail: "result is required" }, 422);
	}
	const { action } = await completeComputerAction(
		actionDependenciesOf(deps.park),
		tenantId,
		pathParameter(c, "action_id"),
		principal.workerId as string,
		{ result: body.result, isError: body.error === true },
	);
	const resumed = await resumeTurnForAction(deps.park, tenantId, action.turnId, action.actionId);
	return c.json({ status: "ok", action_id: action.actionId, turn_id: action.turnId, turn_resumed: resumed }, 200);
}
