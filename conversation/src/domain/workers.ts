import { hashWorkerToken, mintWorkerToken, verifyWorkerTokenHash } from "../auth/worker-credentials.ts";
import { WorkerNotRegisteredError, WorkerTenantMismatchError } from "../http/errors.ts";
import type { Clock, IdSource } from "../http/app.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { Worker } from "../store/codecs/worker.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { ensureComputer } from "./computers.ts";

export { WorkerNotRegisteredError, WorkerTenantMismatchError };

/** Where a worker runs, cheapest first. */
export type CostClass = "local" | "ec2" | "fargate";

/** How a workplace may choose hosts; stored on the computer and overridable per turn. */
export type ComputerPolicy = "prefer_local" | "aws_only" | "local_only";

/** Sort rank of each cost class; a lower rank is chosen first. Ported from python/src/chatticus/models.py lines 66-72. */
export const COST_CLASS_RANK: Record<CostClass, number> = { local: 0, ec2: 1, fargate: 2 };

/** The cost classes that run on AWS. */
export const AWS_COST_CLASSES: ReadonlySet<string> = new Set<CostClass>(["ec2", "fargate"]);

/** Seconds without a heartbeat after which a worker is ignored. Ported from control_plane.py line 262. */
export const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 30;

/** Work a worker may pull: what one turn needs from a host. */
export interface TurnJob {
	jobId: string;
	tenantId: string;
	requiredCapabilities: ReadonlySet<string>;
	computerPolicy: ComputerPolicy;
	computerId: string | null;
	userId: string | null;
	botId: string | null;
}

/** One worker's registration payload. */
export interface WorkerRegistration {
	workerId: string;
	tenantId: string;
	costClass: string;
	capabilities: string[];
	computerId: string | null;
}

/**
 * Register or replace a worker and record a heartbeat. Re-registering rotates the bearer token, and a new token is
 * returned on every successful registration. A worker advertising the computer capability gets the organization
 * computer, created when it does not exist yet.
 *
 * Ported from python/src/chatticus/control_plane.py lines 595-645.
 */
export async function registerWorker(
	registration: WorkerRegistration,
	deps: { store: MessagingStore; clock: Clock; ids: IdSource },
): Promise<string> {
	const existing = await deps.store.getWorker(registration.tenantId, registration.workerId);
	if (existing !== null && existing.tenantId !== registration.tenantId) {
		throw new WorkerTenantMismatchError(
			`Worker ${JSON.stringify(registration.workerId)} is registered to tenant ${JSON.stringify(existing.tenantId)}, not ${JSON.stringify(registration.tenantId)}.`,
		);
	}
	let computerId = registration.computerId;
	if (registration.capabilities.includes("computer")) {
		const organizationComputer = await ensureComputer(registration.tenantId, deps, registration.computerId);
		if (computerId === null) {
			computerId = organizationComputer.computerId;
		}
	}
	const token = mintWorkerToken();
	await deps.store.putWorker({
		workerId: registration.workerId,
		tenantId: registration.tenantId,
		costClass: registration.costClass,
		capabilities: registration.capabilities,
		tokenHash: hashWorkerToken(token),
		lastHeartbeatAt: deps.clock.now(),
		...(computerId === null ? {} : { computerId }),
		...(existing?.hydratedSnapshotGeneration === undefined
			? {}
			: { hydratedSnapshotGeneration: existing.hydratedSnapshotGeneration }),
	});
	return token;
}

/** Return the worker id for a valid bearer token in `tenantId`, or null when no registered worker holds it. */
export async function verifyWorkerToken(
	tenantId: string,
	token: string,
	deps: { store: MessagingStore },
): Promise<string | null> {
	for (const worker of await deps.store.listWorkers(tenantId)) {
		if (verifyWorkerTokenHash(token, worker.tokenHash)) {
			return worker.workerId;
		}
	}
	return null;
}

/**
 * Return a registered worker.
 *
 * Ported from python/src/chatticus/control_plane.py lines 667-676.
 *
 * @throws WorkerNotRegisteredError when the worker is not registered.
 */
export async function getWorker(tenantId: string, workerId: string, deps: { store: MessagingStore }): Promise<Worker> {
	const record = await deps.store.getWorker(tenantId, workerId);
	if (record === null) {
		throw new WorkerNotRegisteredError(workerId);
	}
	return record;
}

/**
 * Refresh a worker's heartbeat.
 *
 * Ported from python/src/chatticus/control_plane.py lines 656-665.
 *
 * @throws WorkerNotRegisteredError when the worker is not registered.
 */
export async function heartbeatWorker(
	tenantId: string,
	workerId: string,
	deps: { store: MessagingStore; clock: Clock },
): Promise<void> {
	const record = await getWorker(tenantId, workerId, deps);
	await deps.store.putWorker({ ...record, lastHeartbeatAt: deps.clock.now() });
}

/** Return every registered worker for one tenant, including stale ones. */
export async function listWorkers(tenantId: string, deps: { store: MessagingStore }): Promise<Worker[]> {
	return deps.store.listWorkers(tenantId);
}

/** Return the workers of a tenant whose heartbeat is no older than `heartbeatTimeoutSeconds`. */
export async function healthyWorkers(
	tenantId: string,
	deps: { store: MessagingStore; clock: Clock; heartbeatTimeoutSeconds: number },
): Promise<Worker[]> {
	const now = deps.clock.now().getTime();
	const healthy: Worker[] = [];
	for (const record of await deps.store.listWorkers(tenantId)) {
		if (now - record.lastHeartbeatAt.getTime() > deps.heartbeatTimeoutSeconds * 1000) {
			continue;
		}
		healthy.push(record);
	}
	return healthy;
}

/** What building a turn job needs. */
export interface TurnJobRequest {
	tenantId: string;
	requiredCapabilities: ReadonlySet<string>;
	computerPolicy?: ComputerPolicy | null;
	computerId?: string | null;
	userId?: string | null;
	botId?: string | null;
}

/**
 * Build the job for one turn. A job that needs the computer capability is pinned to the organization computer and
 * takes its policy unless the request names them. A bot pins the job to the bot's tenant.
 *
 * Ported from python/src/chatticus/control_plane.py lines 719-765. The Python version also appended the job to an
 * in-process pending list; here the turn run queue carries jobs, so this only builds one.
 */
export async function createTurnJob(
	request: TurnJobRequest,
	deps: { store: MessagingStore; ids: IdSource },
): Promise<TurnJob> {
	let tenantId = request.tenantId;
	const botId = request.botId ?? null;
	if (botId !== null) {
		const bot = await deps.store.getBot(tenantId, botId);
		if (bot === null) {
			throw new Error(`Bot ${JSON.stringify(botId)} is not registered.`);
		}
		tenantId = bot.tenantId;
	}
	let computerId = request.computerId ?? null;
	let computerPolicy = request.computerPolicy ?? null;
	if (request.requiredCapabilities.has("computer")) {
		const computer = await ensureComputer(tenantId, deps);
		computerId ??= computer.computerId;
		computerPolicy ??= computer.policy as ComputerPolicy;
	}
	return {
		jobId: deps.ids.next(),
		tenantId,
		requiredCapabilities: request.requiredCapabilities,
		computerPolicy: computerPolicy ?? "prefer_local",
		computerId,
		userId: request.userId ?? null,
		botId,
	};
}

function workerSnapshotIsStale(record: Worker, computer: Computer): boolean {
	if (record.costClass !== "local") {
		return false;
	}
	if (record.computerId !== computer.computerId) {
		return false;
	}
	if (computer.snapshotGeneration === 0) {
		return false;
	}
	return record.hydratedSnapshotGeneration === undefined || record.hydratedSnapshotGeneration < computer.snapshotGeneration;
}

/**
 * Choose a healthy worker for a turn: a computer whose record says it is stopped has no live host whatever the age of its
 * last heartbeat, so a job naming it gets no worker. Otherwise capable, on the job's computer, hydrated, allowed by the policy, and cheapest by
 * cost class then most recently heard from. Returns null when no worker matches.
 *
 * Ported from python/src/chatticus/control_plane.py lines 784-837.
 */
export async function assignTurn(
	job: TurnJob,
	deps: { store: MessagingStore; clock: Clock; heartbeatTimeoutSeconds: number },
): Promise<Worker | null> {
	let candidates = (await healthyWorkers(job.tenantId, deps)).filter((record) =>
		[...job.requiredCapabilities].every((capability) => record.capabilities.includes(capability)),
	);
	if (job.computerId !== null) {
		candidates = candidates.filter((record) => record.computerId === job.computerId);
		const organizationComputer = await deps.store.getComputer(job.tenantId);
		const computer = organizationComputer?.computerId === job.computerId ? organizationComputer : null;
		if (computer !== null) {
			if (computer.stopped) {
				return null;
			}
			candidates = candidates.filter((record) => !workerSnapshotIsStale(record, computer));
			if (computer.hydrateRequired) {
				if (computer.intendedHostWorkerId === undefined) {
					return null;
				}
				candidates = candidates.filter((record) => record.workerId === computer.intendedHostWorkerId);
			}
		}
	}
	if (job.computerPolicy === "local_only") {
		candidates = candidates.filter((record) => record.costClass === "local");
	} else if (job.computerPolicy === "aws_only") {
		candidates = candidates.filter((record) => AWS_COST_CLASSES.has(record.costClass));
	}
	candidates.sort(
		(left, right) =>
			COST_CLASS_RANK[left.costClass as CostClass] - COST_CLASS_RANK[right.costClass as CostClass] ||
			right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime(),
	);
	return candidates[0] ?? null;
}

/**
 * Mark a host as caught up to one published snapshot generation.
 *
 * Ported from python/src/chatticus/control_plane.py `reconcile_worker_snapshot`.
 *
 * @throws WorkerNotRegisteredError when the worker is not registered.
 */
export async function reconcileWorkerSnapshot(
	tenantId: string,
	workerId: string,
	snapshotGeneration: number,
	deps: { store: MessagingStore },
): Promise<void> {
	const record = await getWorker(tenantId, workerId, deps);
	await deps.store.putWorker({ ...record, hydratedSnapshotGeneration: snapshotGeneration });
}

/**
 * Choose a healthy host to start one stopped computer: it advertises the computer and the computer capability, and a
 * local host that last reconciled an older snapshot generation than the published one is passed over. The cheapest cost
 * class wins, then the host heard from most recently.
 *
 * Ported from python/src/chatticus/control_plane.py `select_computer_start_host`.
 *
 * @returns The worker id, or null when no host qualifies.
 */
export async function selectComputerStartHost(
	tenantId: string,
	deps: { store: MessagingStore; clock: Clock; ids: IdSource; heartbeatTimeoutSeconds: number },
): Promise<string | null> {
	const computer = await ensureComputer(tenantId, deps);
	const candidates = (await healthyWorkers(tenantId, deps)).filter(
		(record) =>
			record.computerId === computer.computerId && record.capabilities.includes("computer") && !workerSnapshotIsStale(record, computer),
	);
	candidates.sort(
		(left, right) =>
			COST_CLASS_RANK[left.costClass as CostClass] - COST_CLASS_RANK[right.costClass as CostClass] ||
			right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime(),
	);
	return candidates[0]?.workerId ?? null;
}
