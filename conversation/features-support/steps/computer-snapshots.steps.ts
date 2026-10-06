import assert from "node:assert/strict";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { hydrateOnBoot } from "../../../computer/host/src/disk-lifecycle.ts";
import { HostProtocolError } from "../../../computer/host/src/protocol-client.ts";
import { computerForOrganization, recordHostSnapshotPublished } from "../../src/domain/computers.ts";
import { S3SnapshotStore } from "../../src/snapshot/s3.ts";
import { testS3Client } from "../pi-storage.ts";
import { ComputerDirtyError, SnapshotRequiredError } from "../../src/http/errors.ts";
import { ComputerHostDisk } from "../../src/snapshot/host.ts";
import { packChecksum } from "../../src/snapshot/pack.ts";
import { snapshotUri } from "../../src/snapshot/uri.ts";
import { diskOf } from "../computer-scenario.ts";
import {
	browserSessionPath,
	sharedSnapshotStoreOf,
	snapshotRelocationOf,
	writeComputerContentTo,
} from "../computer-snapshots-support.ts";
import { hostClientFor, hostDiskOf, LIFECYCLE_TENANT } from "../host-lifecycle-support.ts";
import { resetScenarioToEmptyControlPlane } from "./bot.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const WORKSPACE_PATH_PREFIX = "/workspace/";

Given("an empty control plane backed by a Dynamo messaging store", async function (this: ChatticusWorld) {
	await resetScenarioToEmptyControlPlane(this);
});

Given("CHATTICUS_SNAPSHOT_BUCKET names a bucket that does not exist yet", async function (this: ChatticusWorld) {
	const bucket = `chatticus-missing-${this.tenantId}`.toLowerCase();
	const store = new S3SnapshotStore(bucket, testS3Client());
	this.snapshotStore = store;
	const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
	await recordHostSnapshotPublished(
		LIFECYCLE_TENANT,
		"garage-mac-1",
		"0".repeat(64),
		snapshotUri(LIFECYCLE_TENANT, computer.computerId, { bucket }),
		{ store: this.messagingStore() },
	);
});

When(
	"bot {string} saves a browser session {string} as {string}",
	function (this: ChatticusWorld, _botName: string, service: string, session: string) {
		snapshotRelocationOf(this).browserSessions.set(service, session);
	},
);

When(
	"worker {string} publishes a snapshot of computer {string}",
	async function (this: ChatticusWorld, workerId: string, computerId: string) {
		const store = sharedSnapshotStoreOf(this);
		const disk = hostDiskOf(this, workerId);
		writeComputerContentTo(this, LIFECYCLE_TENANT, disk);
		const manifest = await disk.publish({ tenant_id: LIFECYCLE_TENANT, computer_id: computerId, worker_id: workerId });
		await hostClientFor(this, workerId).publishComputerSnapshot(
			workerId,
			manifest.checksum,
			snapshotUri(LIFECYCLE_TENANT, computerId, { bucket: store.bucket }),
		);
	},
);

When(
	"worker {string} hydrates computer {string}",
	async function (this: ChatticusWorld, workerId: string, computerId: string) {
		const scenario = snapshotRelocationOf(this);
		scenario.hydrateError = null;
		scenario.refusalInspected = false;
		const disk = hostDiskOf(this, workerId);
		try {
			await hydrateOnBoot(hostClientFor(this, workerId), {
				tenantId: LIFECYCLE_TENANT,
				workerId,
				liveRoot: disk.liveRoot,
				store: sharedSnapshotStoreOf(this),
			});
		} catch (error) {
			scenario.hydrateError = error as Error;
			return;
		}
		const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
		assert.equal(computer.computerId, computerId);
		for (const [path, content] of diskOf(this, LIFECYCLE_TENANT)) {
			assert.equal(disk.readWorkspaceFile(path.slice(WORKSPACE_PATH_PREFIX.length)), content, `Hydrate left ${path} out of the host disk.`);
		}
	},
);

async function publishedSnapshotReader(world: ChatticusWorld): Promise<ComputerHostDisk> {
	const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: world.messagingStore() });
	assert.ok(computer.snapshotUri, "The computer has no published snapshot.");
	assert.ok(world.snapshotTmpdir, "The scenario has no snapshot directory.");
	const reader = new ComputerHostDisk(join(world.snapshotTmpdir, "readers", String(Date.now())), sharedSnapshotStoreOf(world));
	await reader.hydrate({ tenant_id: LIFECYCLE_TENANT, computer_id: computer.computerId });
	return reader;
}

Then(
	"bot {string} sees browser session {string} as {string}",
	async function (this: ChatticusWorld, _botName: string, service: string, session: string) {
		const reader = await publishedSnapshotReader(this);
		assert.equal(reader.readBrowserProfileFile(browserSessionPath(service)), session);
	},
);

Then("relocate fails because a snapshot is required", function (this: ChatticusWorld) {
	const scenario = snapshotRelocationOf(this);
	scenario.refusalInspected = true;
	assert.ok(scenario.relocateError instanceof SnapshotRequiredError, String(scenario.relocateError));
});

Then("relocate fails because the disk is dirty", function (this: ChatticusWorld) {
	const scenario = snapshotRelocationOf(this);
	scenario.refusalInspected = true;
	assert.ok(scenario.relocateError instanceof ComputerDirtyError, String(scenario.relocateError));
});

Then("hydrate fails because the worker does not host that computer", function (this: ChatticusWorld) {
	const scenario = snapshotRelocationOf(this);
	scenario.refusalInspected = true;
	const error = scenario.hydrateError;
	assert.ok(error instanceof HostProtocolError, String(error));
	assert.equal(error.status, 400, error.message);
	assert.ok(error.message.includes("hosts 'someone-elses-computer', not 'household-computer'"), error.message);
});

Then(
	"computer {string} has snapshot URI {string}",
	async function (this: ChatticusWorld, computerId: string, uri: string) {
		const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
		assert.equal(computer.computerId, computerId);
		assert.equal(computer.snapshotUri, uri);
	},
);

Then("computer {string} is not dirty", async function (this: ChatticusWorld, computerId: string) {
	const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
	assert.equal(computer.computerId, computerId);
	assert.equal(computer.diskDirty, false);
});

Then(
	"tenant {string} computer {string} has snapshot URI {string}",
	async function (this: ChatticusWorld, tenantId: string, computerId: string, uri: string) {
		const computer = await computerForOrganization(tenantId, { store: this.messagingStore() });
		assert.equal(computer.computerId, computerId);
		assert.equal(computer.snapshotUri, uri);
	},
);

Then(
	"tenant {string} computer {string} has snapshot generation {int}",
	async function (this: ChatticusWorld, tenantId: string, computerId: string, generation: number) {
		const computer = await computerForOrganization(tenantId, { store: this.messagingStore() });
		assert.equal(computer.computerId, computerId);
		assert.equal(computer.snapshotGeneration, generation);
	},
);

Then(
	"tenant {string} computer {string} has snapshot checksum for file {string} as {string}",
	async function (this: ChatticusWorld, tenantId: string, computerId: string, path: string, content: string) {
		const computer = await computerForOrganization(tenantId, { store: this.messagingStore() });
		assert.equal(computer.computerId, computerId);
		assert.ok(computer.snapshotUri && computer.snapshotChecksum, "The computer records no published snapshot.");
		const store = sharedSnapshotStoreOf(this);
		assert.equal(computer.snapshotChecksum, packChecksum(await Promise.resolve(store.getPack(computer.snapshotUri))));
		const reader = await publishedSnapshotReader(this);
		assert.equal(reader.readWorkspaceFile(path), content);
	},
);

Then(
	"tenant {string} computer {string} requires hydrate on worker {string}",
	async function (this: ChatticusWorld, tenantId: string, computerId: string, workerId: string) {
		const computer = await computerForOrganization(tenantId, { store: this.messagingStore() });
		assert.equal(computer.computerId, computerId);
		assert.equal(computer.hydrateRequired, true);
		assert.equal(computer.intendedHostWorkerId, workerId);
	},
);
