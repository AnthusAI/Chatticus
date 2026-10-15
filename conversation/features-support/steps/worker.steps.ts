import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { ensureComputer } from "../../src/domain/computers.ts";
import {
	assignTurn,
	createTurnJob,
	getWorker,
	healthyWorkers,
	type ComputerPolicy,
} from "../../src/domain/workers.ts";
import { recordResponse } from "../api.ts";
import type { ChatticusWorld } from "../world.ts";
import { registerWorkerOverHttp } from "./worker-registration.ts";

function valuesOf(table: DataTable): Record<string, string> {
	const values: Record<string, string> = {};
	for (const row of table.raw()) {
		values[(row[0] ?? "").trim()] = (row[1] ?? "").trim();
	}
	return values;
}

function listOf(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

async function registerFromTable(world: ChatticusWorld, table: DataTable): Promise<void> {
	const values = valuesOf(table);
	const previous = world.lastRegisteredWorker?.token ?? null;
	await registerWorkerOverHttp(world, {
		tenantId: values.tenant_id!,
		workerId: values.worker_id!,
		costClass: values.cost_class!,
		capabilities: listOf(values.capabilities ?? ""),
		...(values.computer_id ? { computerId: values.computer_id } : {}),
	});
	world.previousWorkerToken = previous;
}

function registeredWorkerNamed(world: ChatticusWorld, workerId: string): { tenantId: string; workerId: string; token: string } {
	const matches = world.registeredWorkers.filter((worker) => worker.workerId === workerId);
	assert.ok(matches.length > 0, `No tenant is registered for worker ${JSON.stringify(workerId)}.`);
	return matches[0]!;
}

async function sendHeartbeat(world: ChatticusWorld, worker: { tenantId: string; token: string }): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const response = await recordResponse(
		await world.api.post(`/orgs/${worker.tenantId}/host/heartbeat`, {
			headers: { Authorization: `Bearer ${worker.token}` },
		}),
	);
	assert.equal(response.status, 200, response.text);
}

function routingDependencies(world: ChatticusWorld) {
	return { store: world.messagingStore(), clock: world.clock, heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds };
}

Given("the heartbeat timeout is {int} seconds", function (this: ChatticusWorld, seconds: number) {
	this.heartbeatTimeoutSeconds = seconds;
});

Given("a worker registered as:", async function (this: ChatticusWorld, table: DataTable) {
	await registerFromTable(this, table);
});

When("a worker registers:", async function (this: ChatticusWorld, table: DataTable) {
	await registerFromTable(this, table);
});

When("{int} seconds pass", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When("{int} more seconds pass", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When(
	"{int} seconds pass without a heartbeat from {string}",
	async function (this: ChatticusWorld, seconds: number, workerId: string) {
		this.clock.advanceSeconds(seconds);
		for (const worker of this.registeredWorkers) {
			if (worker.workerId !== workerId) {
				await sendHeartbeat(this, worker);
			}
		}
	},
);

When("worker {string} sends a heartbeat", async function (this: ChatticusWorld, workerId: string) {
	await sendHeartbeat(this, registeredWorkerNamed(this, workerId));
});

Then("tenant {string} has {int} healthy worker(s)", async function (this: ChatticusWorld, tenantId: string, count: number) {
	assert.equal((await healthyWorkers(tenantId, routingDependencies(this))).length, count);
});

Then(
	"worker {string} has cost class {string}",
	async function (this: ChatticusWorld, workerId: string, costClass: string) {
		const worker = registeredWorkerNamed(this, workerId);
		assert.equal((await getWorker(worker.tenantId, workerId, { store: this.messagingStore() })).costClass, costClass);
	},
);

Then(
	"worker {string} has computer affinity {string}",
	async function (this: ChatticusWorld, workerId: string, computerId: string) {
		const worker = registeredWorkerNamed(this, workerId);
		assert.equal((await getWorker(worker.tenantId, workerId, { store: this.messagingStore() })).computerId, computerId);
	},
);

Given(
	"tenant {string} user {string} has computer {string}",
	async function (this: ChatticusWorld, tenantId: string, _userId: string, computerId: string) {
		await ensureComputer(tenantId, { store: this.messagingStore(), ids: this.ids }, computerId);
	},
);

async function enqueueAndAssign(
	world: ChatticusWorld,
	tenantId: string,
	table: DataTable,
	botId: string | null,
): Promise<void> {
	const values = valuesOf(table);
	world.lastTurnJob = await createTurnJob(
		{
			tenantId,
			requiredCapabilities: new Set(listOf(values.capabilities ?? "")),
			computerPolicy: (values.policy as ComputerPolicy | undefined) ?? null,
			computerId: values.computer_id || null,
			botId,
		},
		{ store: world.messagingStore(), ids: world.ids },
	);
	world.lastAssignedWorker = await assignTurn(world.lastTurnJob, routingDependencies(world));
}

When("tenant {string} enqueues a turn:", async function (this: ChatticusWorld, tenantId: string, table: DataTable) {
	await enqueueAndAssign(this, tenantId, table, null);
});

When("bot {string} enqueues a turn:", async function (this: ChatticusWorld, name: string, table: DataTable) {
	const bot = this.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	await enqueueAndAssign(this, bot.tenantId, table, bot.botId);
});

Then("the turn is assigned to worker {string}", function (this: ChatticusWorld, workerId: string) {
	assert.ok(this.lastAssignedWorker, "The turn was not assigned to any worker.");
	assert.equal(this.lastAssignedWorker.workerId, workerId);
});

Then("the turn is not assigned", function (this: ChatticusWorld) {
	assert.equal(this.lastAssignedWorker, null);
});
