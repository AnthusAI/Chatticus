import assert from "node:assert/strict";
import { join } from "node:path";
import { After } from "@cucumber/cucumber";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { HostAction } from "@chatticus/host-protocol";
import { ComputerHostBootDriver, type DisplayServer } from "../../computer/host/src/boot.ts";
import { WorkspaceActionExecutor } from "../../computer/host/src/executors/workspace.ts";
import { HostActionExecutor } from "../../computer/host/src/host-action-executor.ts";
import { runHostWorkerOnce, type HostActionRunner } from "../../computer/host/src/main.ts";
import { HostProtocolClient } from "../../computer/host/src/protocol-client.ts";
import { ensureComputer } from "../src/domain/computers.ts";
import { encodeAction } from "../src/store/codecs/action.ts";
import { ComputerHostDisk } from "../src/snapshot/host.ts";
import { FilesystemSnapshotStore, type SnapshotObjectStore } from "../src/snapshot/store.ts";
import { actionStoreOf } from "./computer-support.ts";
import { FakeHostStartDriver } from "./fakes/fake-host-start-driver.ts";
import { activeTurnOf } from "./turn-grant-support.ts";
import { testS3Client } from "./pi-storage.ts";
import { registerWorkerOverHttp } from "./steps/worker-registration.ts";
import type { ChatticusWorld } from "./world.ts";

/** The organization and member of the host lifecycle scenarios. */
export const LIFECYCLE_TENANT = "anthus";
export const LIFECYCLE_USER = "ryan";

/** The version line the faked Chromium probe reports. */
export const FAKE_CHROMIUM_VERSION = "Chromium 120.0.0.0";

const FRONT_DOOR_ORIGIN = "http://front-door.test";
const SNAPSHOT_METADATA_ROUTES = ["/snapshot/hydrated", "/snapshot/published"];

/** What one host lifecycle scenario remembers between its steps. */
export type HostLifecycleScenario = {
	/** The snapshot metadata requests the Front Door received from hosts. */
	snapshotMetadataRequests: number;
	/** The host that booted last, so a step can run the host that is up. */
	lastBootedHost: string | null;
	/** What the last boot reported. */
	readinessOrder: readonly string[];
	/** How the last snapshot publish ended when a step expected a refusal. */
	publishError: Error | null;
	/** The bucket of the organization's own snapshot store, when the scenario gave it one. */
	organizationBucket: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, HostLifecycleScenario>();

/** The scenario's host lifecycle state, created on first use. */
export function lifecycleOf(world: ChatticusWorld): HostLifecycleScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { snapshotMetadataRequests: 0, lastBootedHost: null, readinessOrder: [], publishError: null, organizationBucket: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/**
 * The fetch a host reaches the Front Door with: the scenario's production application, read lazily so a recycled front
 * door answers the next request. It counts the snapshot metadata requests it carries.
 */
export function frontDoorFetch(world: ChatticusWorld): typeof fetch {
	return (async (input: Request | URL | string, init?: RequestInit) => {
		assert.ok(world.app, "The scenario has no HTTP front door.");
		const url = String(input);
		if (SNAPSHOT_METADATA_ROUTES.some((route) => url.includes(route))) {
			lifecycleOf(world).snapshotMetadataRequests += 1;
		}
		return world.app.request(url, init);
	}) as typeof fetch;
}

/** Register a host worker of the organization's computer over HTTP, unless the scenario already did. */
export async function ensureHostWorker(world: ChatticusWorld, tenantId: string, workerId: string): Promise<string> {
	const known = world.registeredWorkers.find((worker) => worker.workerId === workerId);
	if (known !== undefined) return known.token;
	const computer = await ensureComputer(tenantId, { store: world.messagingStore(), ids: world.ids });
	return registerWorkerOverHttp(world, {
		tenantId,
		workerId,
		costClass: "local",
		capabilities: ["computer", "browser"],
		computerId: computer.computerId,
	});
}

/** The protocol client of one registered host worker. */
export function hostClientFor(world: ChatticusWorld, workerId: string, tenantId: string = LIFECYCLE_TENANT): HostProtocolClient {
	const worker = world.registeredWorkers.find((candidate) => candidate.workerId === workerId);
	assert.ok(worker, `No host worker ${JSON.stringify(workerId)} is registered in this scenario.`);
	return new HostProtocolClient({
		baseUrl: FRONT_DOOR_ORIGIN,
		tenantId,
		workerToken: worker.token,
		userId: LIFECYCLE_USER,
		fetchFunction: frontDoorFetch(world),
	});
}

/** The disk of one named host: its live root and the snapshot store the scenario bound. */
export function hostDiskOf(world: ChatticusWorld, name: string): ComputerHostDisk {
	const known = world.computerHosts[name] as ComputerHostDisk | undefined;
	if (known !== undefined) return known;
	assert.ok(world.snapshotTmpdir, "The scenario has no snapshot directory.");
	const store = (world.snapshotStore as SnapshotObjectStore | null) ?? new FilesystemSnapshotStore(join(world.snapshotTmpdir, "store"));
	const disk = new ComputerHostDisk(join(world.snapshotTmpdir, "hosts", name), store);
	world.computerHosts[name] = disk;
	return disk;
}

/** A display that only counts how often the host started it; the real one is Xvfb. */
export class FakeDisplayServer implements DisplayServer {
	starts = 0;

	async start(): Promise<void> {
		this.starts += 1;
	}

	async stop(): Promise<void> {}
}

/**
 * The boot driver of one registered host, over its own live root. The display and the Chromium probe are fakes because a
 * real Chromium is not available in tests; everything else is the production boot.
 *
 * @param world The scenario world.
 * @param workerId The registered host worker.
 * @param store The snapshot store the host hydrates from; null boots a host that has none configured.
 */
export function bootDriverFor(world: ChatticusWorld, workerId: string, store: SnapshotObjectStore | null): ComputerHostBootDriver {
	return new ComputerHostBootDriver(hostClientFor(world, workerId), {
		tenantId: LIFECYCLE_TENANT,
		workerId,
		xvfb: new FakeDisplayServer(),
		chromiumProbe: async () => FAKE_CHROMIUM_VERSION,
		liveRoot: hostDiskOf(world, workerId).liveRoot,
		store,
	});
}

/** The host executor of one named host over its disk, as the production host builds it. */
export function hostExecutorFor(world: ChatticusWorld, workerId: string): HostActionExecutor {
	const disk = hostDiskOf(world, workerId);
	return new HostActionExecutor({ workspaceExecutor: new WorkspaceActionExecutor({ disk }), liveRoot: disk.liveRoot });
}

/**
 * Run the production host loop body for one host until nothing waits for it: claim, re-gate, execute, report.
 *
 * @returns The actions that were run.
 */
export async function runHostUntilIdle(world: ChatticusWorld, workerId: string, executor: HostActionRunner): Promise<HostAction[]> {
	const plane = hostClientFor(world, workerId);
	const ran: HostAction[] = [];
	for (let action = await runHostWorkerOnce(plane, executor); action !== null; action = await runHostWorkerOnce(plane, executor)) {
		ran.push(action);
	}
	return ran;
}

/** The host start driver of a started host: it runs the named hosts' loops, as a host that was started by the platform does. */
export function loopHostStartDriver(run: () => Promise<unknown>): FakeHostStartDriver {
	return new FakeHostStartDriver(async () => {
		await run();
	});
}

const organizationBuckets = new WeakMap<ChatticusWorld, string>();

/** Create the organization's snapshot bucket on the scenario's S3 and remember it for the scenario's end. */
export async function createOrganizationBucket(world: ChatticusWorld, bucket: string): Promise<void> {
	const client = testS3Client();
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: { name?: string }) => {
			if (error.name !== "BucketAlreadyOwnedByYou") throw error;
		});
	} finally {
		client.destroy();
	}
	organizationBuckets.set(world, bucket);
	lifecycleOf(world).organizationBucket = bucket;
}

After(async function (this: ChatticusWorld) {
	const bucket = organizationBuckets.get(this);
	if (bucket === undefined) return;
	organizationBuckets.delete(this);
	const client = testS3Client();
	try {
		let continuation: string | undefined;
		do {
			const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuation }));
			const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
			if (keys.length > 0) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
			continuation = page.NextContinuationToken;
		} while (continuation !== undefined);
		await client.send(new DeleteBucketCommand({ Bucket: bucket }));
	} finally {
		client.destroy();
	}
});

/**
 * Rewrite the arguments of the active turn's parked action in the Messaging table, as someone who can write to the store
 * and not through the platform would. The host claims the action with the arguments it now holds.
 *
 * @param world The scenario world.
 * @param tampered The arguments to overwrite.
 */
export async function tamperPendingAction(world: ChatticusWorld, tampered: Readonly<Record<string, string>>): Promise<void> {
	const { tenantId, turnId } = activeTurnOf(world);
	const [action] = await actionStoreOf(world).listForTurn(tenantId, turnId);
	assert.ok(action, "The turn has no parked action to tamper with.");
	await world.messagingTable.client.send(
		new PutItemCommand({
			TableName: world.messagingTable.tableName,
			Item: encodeAction({ ...action, arguments: { ...action.arguments, ...tampered } }),
		}),
	);
}
