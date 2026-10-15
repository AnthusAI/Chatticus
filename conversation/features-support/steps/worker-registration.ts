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
};

/** Register one worker over HTTP, keep its bearer token on the world, and return the token. */
export async function registerWorkerOverHttp(world: ChatticusWorld, request: WorkerRegistrationRequest): Promise<string> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const body: Record<string, unknown> = {
		worker_id: request.workerId,
		cost_class: request.costClass,
		capabilities: request.capabilities,
	};
	if (request.computerId !== undefined) {
		body.computer_id = request.computerId;
	}
	const response = await recordResponse(
		await world.api.post(`/orgs/${request.tenantId}/workers/register`, { headers: request.headers ?? {}, body }),
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
