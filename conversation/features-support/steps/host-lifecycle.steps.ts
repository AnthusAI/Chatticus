import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Given, Then, When } from "@cucumber/cucumber";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { HostProtocolError } from "../../../computer/host/src/protocol-client.ts";
import { shutdownHostWorker } from "../../../computer/host/src/main.ts";
import { S3SnapshotStore } from "../../src/snapshot/s3.ts";
import { customerSnapshotBucketName } from "../../src/snapshot/customer-bucket.ts";
import { type SnapshotObjectStore } from "../../src/snapshot/store.ts";
import { PACK_FILENAME, snapshotBucketAndPrefix, snapshotUri } from "../../src/snapshot/uri.ts";
import { computerForOrganization, recordHostSnapshotPublished } from "../../src/domain/computers.ts";
import { wireFrontDoor } from "../front-door.ts";
import { snapshotRelocationOf } from "../computer-snapshots-support.ts";
import {
	LIFECYCLE_TENANT,
	bootDriverFor,
	createOrganizationBucket,
	ensureHostWorker,
	hostClientFor,
	hostDiskOf,
	lifecycleOf,
} from "../host-lifecycle-support.ts";
import { testS3Client } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";

const READINESS_HOST_WORKER_ID = "garage-mac-1";
const UNPUBLISHED_CHECKSUM = "0".repeat(64);

function boundStoreOf(world: ChatticusWorld): SnapshotObjectStore {
	assert.ok(world.snapshotStore, "The scenario has no snapshot store bound to the host worker.");
	return world.snapshotStore as SnapshotObjectStore;
}

async function bootHost(world: ChatticusWorld, workerId: string, store: SnapshotObjectStore | null): Promise<void> {
	const driver = bootDriverFor(world, workerId, store);
	await driver.bootThroughBrowser();
	const lifecycle = lifecycleOf(world);
	lifecycle.lastBootedHost = workerId;
	lifecycle.readinessOrder = [...driver.readinessOrder];
}

function assertCleared(order: readonly string[], first: string, second: string): void {
	assert.ok(order.includes(first) && order.includes(second), `The host reported ${JSON.stringify(order)}.`);
	assert.ok(order.indexOf(first) < order.indexOf(second), `The host reported ${JSON.stringify(order)}.`);
}

Given(
	"worker {string} has published computer {string} with workspace file {string} containing {string}",
	async function (this: ChatticusWorld, workerId: string, computerId: string, path: string, content: string) {
		const store = boundStoreOf(this);
		const disk = hostDiskOf(this, workerId);
		disk.writeWorkspaceFile(path, content);
		const manifest = await disk.publish({ tenant_id: LIFECYCLE_TENANT, computer_id: computerId, worker_id: workerId });
		await recordHostSnapshotPublished(
			LIFECYCLE_TENANT,
			workerId,
			manifest.checksum,
			snapshotUri(LIFECYCLE_TENANT, computerId, { bucket: store.bucket }),
			{ store: this.messagingStore() },
		);
	},
);

When(
	"computer {string} awaits hydration on worker {string}",
	async function (this: ChatticusWorld, computerId: string, workerId: string) {
		const store = this.messagingStore();
		const computer = await computerForOrganization(LIFECYCLE_TENANT, { store });
		assert.equal(computer.computerId, computerId);
		await store.putComputer({ ...computer, intendedHostWorkerId: workerId, hydrateRequired: true });
	},
);

When(
	"the customer computer host {string} boots through the Front Door worker plane",
	async function (this: ChatticusWorld, workerId: string) {
		await bootHost(this, workerId, boundStoreOf(this));
	},
);

When("the customer computer host {string} boots without a snapshot store", async function (this: ChatticusWorld, workerId: string) {
	await bootHost(this, workerId, null);
});

When(
	"the customer computer host {string} shuts down through the Front Door worker plane",
	async function (this: ChatticusWorld, workerId: string) {
		await shutdownHostWorker(hostClientFor(this, workerId), {
			tenantId: LIFECYCLE_TENANT,
			workerId,
			liveRoot: hostDiskOf(this, workerId).liveRoot,
			store: boundStoreOf(this),
		});
	},
);

When("the Front Door is recycled onto the same messaging store", async function (this: ChatticusWorld) {
	assert.ok(this.frontDoorOptions, "The scenario has no HTTP front door to recycle.");
	this.scenarioMessagingStore = this.createMessagingStore();
	await wireFrontDoor(this, this.frontDoorOptions);
});

When("the local disk of host {string} is wiped", function (this: ChatticusWorld, workerId: string) {
	const liveRoot = hostDiskOf(this, workerId).liveRoot;
	rmSync(liveRoot, { recursive: true, force: true });
	assert.equal(existsSync(liveRoot), false);
	mkdirSync(liveRoot, { recursive: true });
});

When(
	"worker {string} posts snapshot publish metadata as worker {string}",
	async function (this: ChatticusWorld, callerId: string, claimedId: string) {
		lifecycleOf(this).publishError = null;
		try {
			await hostClientFor(this, callerId).publishComputerSnapshot(claimedId, UNPUBLISHED_CHECKSUM);
		} catch (error) {
			lifecycleOf(this).publishError = error as Error;
		}
	},
);

Then("snapshot metadata publish is rejected with forbidden", function (this: ChatticusWorld) {
	const error = lifecycleOf(this).publishError;
	assert.ok(error instanceof HostProtocolError, "The publish was not refused.");
	assert.equal(error.status, 403, error.message);
	assert.ok(error.message.includes("403"), error.message);
});

Then("the Front Door received no snapshot hydrate or publish requests", function (this: ChatticusWorld) {
	assert.equal(lifecycleOf(this).snapshotMetadataRequests, 0);
});

Then("computer {string} does not require hydrate", async function (this: ChatticusWorld, computerId: string) {
	const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
	assert.equal(computer.computerId, computerId);
	assert.equal(computer.hydrateRequired, false);
});

Then("tenant {string} computer {string} is dirty on the store", async function (this: ChatticusWorld, tenantId: string, computerId: string) {
	const computer = await computerForOrganization(tenantId, { store: this.messagingStore() });
	assert.equal(computer.computerId, computerId);
	assert.equal(computer.diskDirty, true);
});

Then("tenant {string} computer {string} is not dirty on the store", async function (this: ChatticusWorld, tenantId: string, computerId: string) {
	const computer = await computerForOrganization(tenantId, { store: this.messagingStore() });
	assert.equal(computer.computerId, computerId);
	assert.equal(computer.diskDirty, false);
	assert.ok(computer.snapshotChecksum, "The computer records no published checksum.");
});

Then(
	"tenant {string} household computer readiness reports workspace ready after model",
	async function (this: ChatticusWorld, tenantId: string) {
		const lifecycle = lifecycleOf(this);
		assertCleared(lifecycle.readinessOrder, "model", "workspace");
		const computer = await hostClientFor(this, lifecycle.lastBootedHost!, tenantId).getComputer();
		assert.equal(computer.workspace_ready, true);
	},
);

Then(
	"tenant {string} household computer readiness reports browser ready after workspace",
	async function (this: ChatticusWorld, tenantId: string) {
		const lifecycle = lifecycleOf(this);
		assertCleared(lifecycle.readinessOrder, "workspace", "browser");
		const computer = await hostClientFor(this, lifecycle.lastBootedHost!, tenantId).getComputer();
		assert.equal(computer.browser_ready, true);
	},
);

When("the computer host finishes booting through model and workspace gates", async function (this: ChatticusWorld) {
	await ensureHostWorker(this, LIFECYCLE_TENANT, READINESS_HOST_WORKER_ID);
	const driver = bootDriverFor(this, READINESS_HOST_WORKER_ID, null);
	await driver.bootThroughWorkspace();
	const lifecycle = lifecycleOf(this);
	lifecycle.lastBootedHost = READINESS_HOST_WORKER_ID;
	lifecycle.readinessOrder = [...driver.readinessOrder];
});

Then("model readiness is recorded before browser readiness", async function (this: ChatticusWorld) {
	const lifecycle = lifecycleOf(this);
	const computer = await hostClientFor(this, lifecycle.lastBootedHost!).getComputer();
	assert.equal(computer.model_ready, true);
	assert.equal(computer.workspace_ready, true);
	assert.equal(computer.browser_ready, false);
	assertCleared(lifecycle.readinessOrder, "model", "workspace");
});

Given("a customer organization snapshot bucket bound to the host worker", async function (this: ChatticusWorld) {
	const bucket = customerSnapshotBucketName(LIFECYCLE_TENANT);
	await createOrganizationBucket(this, bucket);
	this.computerHosts = {};
	this.snapshotStore = new S3SnapshotStore(bucket, testS3Client());
});

Then(
	"the snapshot store has a pack in the organization snapshot bucket for tenant {string} computer {string}",
	async function (this: ChatticusWorld, tenantId: string, computerId: string) {
		const bucket = lifecycleOf(this).organizationBucket;
		assert.ok(bucket, "The scenario has no organization snapshot bucket.");
		const [, prefix] = snapshotBucketAndPrefix(snapshotUri(tenantId, computerId, { bucket }));
		const client = testS3Client();
		try {
			const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}/${PACK_FILENAME}` }));
			assert.ok((head.ContentLength ?? 0) > 0, "The pack in the organization bucket is empty.");
		} finally {
			client.destroy();
		}
	},
);
