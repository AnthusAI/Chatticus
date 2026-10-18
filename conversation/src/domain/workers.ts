import { hashWorkerToken, mintWorkerToken, verifyWorkerTokenHash, workerIdOfToken } from "../auth/worker-credentials.ts";
import { WorkerNotRegisteredError, WorkerRegistrationRefusedError, WorkerTenantMismatchError } from "../http/errors.ts";
import type { Clock, IdSource } from "../http/app.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { Worker } from "../store/codecs/worker.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { ensureComputer } from "./computers.ts";

export { WorkerNotRegisteredError, WorkerRegistrationRefusedError, WorkerTenantMismatchError };

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
	let computerId = registration.computerId;
	if (registration.capabilities.includes("computer")) {
		const organizationComputer = await ensureComputer(registration.tenantId, deps, registration.computerId);
		if (computerId === null) {
			computerId = organizationComputer.computerId;
		}
	}
	const token = mintWorkerToken(registration.workerId);
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

/**
 * Register a worker on behalf of a caller the front door has not otherwise identified. The organization must exist and be
 * enabled, and a worker id that is already registered can be registered again only by the holder of its current bearer
 * token, so holding the shared invoke key neither creates computers for unknown organizations nor rotates another worker's
 * token. Both refusals answer alike so that a caller cannot probe which organizations exist.
 *
 * @throws WorkerRegistrationRefusedError when the organization is unavailable or the current token is missing or wrong.
 */
export async function registerWorkerForCaller(
	registration: WorkerRegistration,
	presentedToken: string | null,
	deps: { store: MessagingStore; clock: Clock; ids: IdSource },
): Promise<string> {
	const organization = await deps.store.getOrganization(registration.tenantId);
	if (organization === null || organization.status !== "enabled") {
		throw new WorkerRegistrationRefusedError("The organization is not available for worker registration.");
	}
	const existing = await deps.store.getWorker(registration.tenantId, registration.workerId);
	if (existing !== null) {
		const presentedTokenIsCurrent =
			presentedToken !== null && verifyWorkerTokenHash(presentedToken, existing.tokenHash);
		if (!presentedTokenIsCurrent) {
			throw new WorkerRegistrationRefusedError(
				`Worker ${JSON.stringify(registration.workerId)} is already registered; its current bearer token is required to register it again.`,
			);
		}
	}
	return registerWorker(registration, deps);
}

/** Longest worker id a credential may claim; a user's identity token is longer and is not looked up as a worker. */
const MAX_CLAIMED_WORKER_ID_LENGTH = 200;

/**
 * Return the worker id for a valid bearer token in `tenantId`, or null when no registered worker holds it. The worker id
 * in front of the token selects the one record to compare, so a request costs one read however many workers the
 * organization has accumulated.
 */
export async function verifyWorkerToken(
	tenantId: string,
	token: string,
	deps: { store: MessagingStore },
): Promise<string | null> {
	const claimedWorkerId = workerIdOfToken(token);
	if (claimedWorkerId === null || claimedWorkerId.length > MAX_CLAIMED_WORKER_ID_LENGTH) {
		return null;
	}
	const worker = await deps.store.getWorker(tenantId, claimedWorkerId);
	return worker !== null && verifyWorkerTokenHash(token, worker.tokenHash) ? worker.workerId : null;
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

