import type { Context } from "hono";
import type { ZodType } from "zod";
import {
	BROWSE_ACTION_KIND,
	HOST_USER_HEADER,
	actionResultRequestSchema,
	claimActionRequestSchema,
	computerStateRequestSchema,
	heartbeatRequestSchema,
	regateActionRequestSchema,
	renewActionRequestSchema,
	snapshotHydratedRequestSchema,
	snapshotPublishedRequestSchema,
} from "@chatticus/host-protocol";
import { StorePrincipalDirectory } from "../auth/store-principal-directory.ts";
import { enforceWorkerPrincipal } from "../auth/worker-principal.ts";
import { pythonRepr } from "../domain/bots.ts";
import {
	claimNextComputerAction,
	completeComputerAction,
	renewComputerAction,
	ComputerActionNotClaimedError,
	ComputerActionNotFoundError,
} from "../domain/actions.ts";
import {
	computerForOrganization,
	recordComputerCapabilityReady,
	recordComputerToolAnswered,
	refuseDiskWriteBeforeHydrate,
	recordHostHydrated,
	recordHostSnapshotPublished,
	setComputerStopped,
} from "../domain/computers.ts";
import { heartbeatWorker } from "../domain/workers.ts";
import { evaluateModelToolRequest } from "../pi/gate.ts";
import { PolicyControl } from "../policy/policy-control.ts";
import type { PolicyStore } from "../store/policy-store.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { type ParkDependencies, actionDependenciesOf, resumeTurnForAction } from "../turn/park.ts";
import { MemberStandingRequiredError } from "./errors.ts";
import type { Clock, IdSource } from "./app.ts";
import { computerPayload, actionPayload } from "./routes/computers.ts";
import { pathParameter } from "./user-principal.ts";

/** Everything the nine host routes depend on. */
export interface HostRouteDependencies {
	store: MessagingStore;
	clock: Clock;
	ids: IdSource;
	park: ParkDependencies;
	policyStore: PolicyStore;
}

type Parsed<T> = { readonly value: T } | { readonly refusal: Response };

async function parseHostBody<T>(c: Context, schema: ZodType<T>): Promise<Parsed<T>> {
	const text = await c.req.text();
	let raw: unknown = {};
	if (text.trim() !== "") {
		try {
			raw = JSON.parse(text);
		} catch {
			return { refusal: c.json({ detail: "body must be JSON" }, 422) };
		}
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return { refusal: c.json({ detail: parsed.error.issues.map((issue) => issue.message).join("; ") }, 422) };
	}
	return { value: parsed.data };
}

async function workerOf(c: Context, deps: HostRouteDependencies): Promise<{ tenantId: string; workerId: string }> {
	const tenantId = pathParameter(c, "tenant_id");
	const principal = await enforceWorkerPrincipal(c.req.raw, tenantId, new StorePrincipalDirectory(deps.store));
	return { tenantId, workerId: principal.workerId as string };
}

function workerIdMismatch(c: Context): Response {
	return c.json({ detail: "worker credential does not match worker_id" }, 403);
}

/** GET /orgs/{tenant_id}/host/computer: the organization computer, with its stopped flag and readiness. */
export async function hostGetComputerHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId } = await workerOf(c, deps);
	return c.json(computerPayload(await computerForOrganization(tenantId, deps)), 200);
}

/**
 * POST /orgs/{tenant_id}/host/computer/state: the host reports the computer running or stopped and which capability
 * cleared. A readiness report names the member the host serves in the host user header.
 */
export async function hostComputerStateHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId } = await workerOf(c, deps);
	const body = await parseHostBody(c, computerStateRequestSchema);
	if ("refusal" in body) return body.refusal;
	if (body.value.capability_ready !== undefined && (c.req.header(HOST_USER_HEADER) ?? "").trim() === "") {
		return c.json({ detail: "host user scope required" }, 403);
	}
	let computer = await computerForOrganization(tenantId, deps);
	if (body.value.stopped !== undefined) {
		computer = await setComputerStopped(tenantId, body.value.stopped, deps);
	}
	if (body.value.capability_ready !== undefined) {
		computer = await recordComputerCapabilityReady(tenantId, body.value.capability_ready, deps);
	}
	return c.json(computerPayload(computer), 200);
}

/** POST /orgs/{tenant_id}/host/snapshot/hydrated: the host hydrated the published snapshot onto its disk. */
export async function hostSnapshotHydratedHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, snapshotHydratedRequestSchema);
	if ("refusal" in body) return body.refusal;
	if (body.value.worker_id !== workerId) return workerIdMismatch(c);
	await recordHostHydrated(tenantId, workerId, deps);
	return c.json({ status: "hydrated" }, 200);
}

/** POST /orgs/{tenant_id}/host/snapshot/published: the host uploaded a pack and reports its checksum and location. */
export async function hostSnapshotPublishedHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, snapshotPublishedRequestSchema);
	if ("refusal" in body) return body.refusal;
	if (body.value.worker_id !== workerId) return workerIdMismatch(c);
	await recordHostSnapshotPublished(tenantId, workerId, body.value.checksum, body.value.snapshot_uri ?? null, deps);
	return c.json({ status: "published" }, 200);
}

/**
 * POST /orgs/{tenant_id}/host/actions/claim: the next computer action of the organization under a lease, or
 * `action: null` when nothing is waiting for this worker.
 */
export async function hostClaimActionHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, claimActionRequestSchema);
	if ("refusal" in body) return body.refusal;
	const computer = await deps.store.getComputer(tenantId);
	const action = await claimNextComputerAction(actionDependenciesOf(deps.park), tenantId, workerId, (candidate) =>
		refuseDiskWriteBeforeHydrate(candidate.toolName, computer),
	);
	return c.json({ action: action === null ? null : actionPayload(action) }, 200);
}

/** POST /orgs/{tenant_id}/host/actions/{action_id}/renew: extend the lease of the action this host holds. */
export async function hostRenewActionHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, renewActionRequestSchema);
	if ("refusal" in body) return body.refusal;
	const action = await renewComputerAction(actionDependenciesOf(deps.park), tenantId, pathParameter(c, "action_id"), workerId);
	return c.json({ action: actionPayload(action) }, 200);
}

/**
 * POST /orgs/{tenant_id}/host/actions/{action_id}/result: the host posts what its tool answered, or the error it failed
 * with. The first answer wins; the turn parked on the action goes back to the run queue.
 */
export async function hostActionResultHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, actionResultRequestSchema);
	if ("refusal" in body) return body.refusal;
	const answer = "result" in body.value ? { result: body.value.result, isError: false } : { result: body.value.error, isError: true };
	const { action, recorded } = await completeComputerAction(actionDependenciesOf(deps.park), tenantId, pathParameter(c, "action_id"), workerId, answer);
	if (recorded) {
		await recordComputerToolAnswered(tenantId, action.toolName, deps);
	}
	const resumed = await resumeTurnForAction(deps.park, tenantId, action.turnId, action.actionId);
	return c.json({ status: "ok", action_id: action.actionId, turn_id: action.turnId, turn_resumed: resumed }, 200);
}

const REGATE_TOOLS = {
	browse: { toolName: BROWSE_ACTION_KIND, argumentName: "url" },
	read: { toolName: "read_workspace", argumentName: "path" },
	write: { toolName: "write_workspace", argumentName: "path" },
	terminal: { toolName: "run_terminal", argumentName: "cwd" },
} as const;

/**
 * POST /orgs/{tenant_id}/host/actions/{action_id}/regate: the host asks whether its action may reach one more origin or
 * path than the envelope names. The answer is the verdict of the same gate the executor used for the turn: 200 when
 * allowed, 403 with the reason when not.
 */
export async function hostRegateActionHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, regateActionRequestSchema);
	if ("refusal" in body) return body.refusal;
	const actionId = pathParameter(c, "action_id");
	const action = await deps.park.computer.actions.get(tenantId, actionId);
	if (action === null) {
		throw new ComputerActionNotFoundError(`Computer action ${pythonRepr(actionId)} does not exist.`);
	}
	if (action.status !== "claimed" || action.claimedBy !== workerId) {
		throw new ComputerActionNotClaimedError(`Computer action ${pythonRepr(actionId)} is not claimed by worker ${pythonRepr(workerId)}.`);
	}
	const policy = new PolicyControl({
		policyStore: deps.policyStore,
		store: deps.store,
		clock: deps.clock,
		ids: deps.ids,
	});
	const { toolName, argumentName } = REGATE_TOOLS[body.value.kind];
	const verdict = await evaluateModelToolRequest(
		{
			now: () => deps.clock.now(),
			readGrant: () => deps.park.turns.store.getGrant(tenantId, action.turnId),
			resolveStanding: (actionType) => {
				if (action.userId === null) {
					throw new MemberStandingRequiredError(`Turn ${pythonRepr(action.turnId)} has no prompt message.`);
				}
				return policy.memberStandingForUser(tenantId, action.userId, actionType);
			},
		},
		toolName,
		{ [argumentName]: body.value.target },
	);
	if (!verdict.allowed) {
		return c.json({ detail: verdict.reason }, 403);
	}
	return c.json({ status: "ok" }, 200);
}

/** POST /orgs/{tenant_id}/host/heartbeat: refresh the heartbeat of the worker that holds the bearer credential. */
export async function hostHeartbeatHandler(c: Context, deps: HostRouteDependencies): Promise<Response> {
	const { tenantId, workerId } = await workerOf(c, deps);
	const body = await parseHostBody(c, heartbeatRequestSchema);
	if ("refusal" in body) return body.refusal;
	await heartbeatWorker(tenantId, workerId, deps);
	return c.json({ status: "ok" }, 200);
}
