import assert from "node:assert/strict";
import { recordResponse } from "../api.ts";
import type { ChatticusWorld } from "../world.ts";

/** One worker registration sent through the scenario's HTTP front door. */
export type WorkerRegistrationRequest = {
	tenantId: string;
	workerId: string;
	costClass: string;
	capabilities: string[];
	computerId?: string;
	headers?: Record<string, string>;
	organizationState?: "enabled" | "absent";
};

async function ensureEnabledOrganization(world: ChatticusWorld, tenantId: string): Promise<void> {
	const store = world.messagingStore();
	if ((await store.getOrganization(tenantId)) !== null) {
		return;
	}
	await store.putOrganization({
		tenantId,
		name: tenantId,
		status: "enabled",
		ownerUserId: "worker-registration-support-owner",
		createdAt: world.clock.now(),
		awsAccountId: null,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: null,
		setupFeeCents: null,
		assistedSetupSession: false,
		monthlyAwsSpendCeilingUsd: null,
	});
}

function currentTokenOf(world: ChatticusWorld, tenantId: string, workerId: string): string | undefined {
	return world.registeredWorkers.find((worker) => worker.tenantId === tenantId && worker.workerId === workerId)?.token;
}

/** Register one worker over HTTP, keep its bearer token on the world, and return the token. */
export async function registerWorkerOverHttp(world: ChatticusWorld, request: WorkerRegistrationRequest): Promise<string> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	if ((request.organizationState ?? "enabled") === "enabled") {
		await ensureEnabledOrganization(world, request.tenantId);
	}
	const currentToken = currentTokenOf(world, request.tenantId, request.workerId);
	const authorizationHeaders: Record<string, string> = currentToken === undefined ? {} : { Authorization: `Bearer ${currentToken}` };
	const body: Record<string, unknown> = {
		worker_id: request.workerId,
		cost_class: request.costClass,
		capabilities: request.capabilities,
	};
	if (request.computerId !== undefined) {
		body.computer_id = request.computerId;
	}
	const response = await recordResponse(
		await world.api.post(`/orgs/${request.tenantId}/workers/register`, { headers: { ...authorizationHeaders, ...request.headers }, body }),
	);
	assert.equal(response.status, 200, response.text);
	const token = response.json.token as string;
	world.workerTokens.set(response.json.worker_id as string, token);
	const registered = { tenantId: request.tenantId, workerId: response.json.worker_id as string, token };
	world.registeredWorkers = world.registeredWorkers.filter(
		(worker) => !(worker.tenantId === registered.tenantId && worker.workerId === registered.workerId),
	);
	world.registeredWorkers.push(registered);
	world.lastRegisteredWorker = registered;
	return token;
}
