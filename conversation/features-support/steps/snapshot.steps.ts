import { Given, When, Then } from "@cucumber/cucumber";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ComputerHostDisk } from "../../src/snapshot/host.ts";
import { FilesystemSnapshotStore } from "../../src/snapshot/store.ts";
import { PACK_FILENAME, snapshotObjectDir, snapshotUri } from "../../src/snapshot/uri.ts";
import { WORKSPACE_DIRNAME } from "../../src/browser-profiles.ts";
import type { ChatticusWorld } from "../world.ts";
import type { SnapshotManifest } from "../../src/snapshot/store.ts";

/**
 * Filesystem store that counts pack downloads.
 */
export class CountingSnapshotStore {
	inner: FilesystemSnapshotStore;
	bucket: string;
	packDownloads: number = 0;

	constructor(inner: FilesystemSnapshotStore) {
		this.inner = inner;
		this.bucket = inner.bucket;
	}

	put(snapshotUri: string, pack: Buffer, manifest: SnapshotManifest): void {
		return this.inner.put(snapshotUri, pack, manifest);
	}

	async getPack(snapshotUri: string): Promise<Buffer> {
		this.packDownloads++;
		return this.inner.getPack(snapshotUri);
	}

	async getManifest(snapshotUri: string): Promise<SnapshotManifest> {
		return this.inner.getManifest(snapshotUri);
	}
}

Given("a filesystem snapshot store", function (this: ChatticusWorld): void {
	const root = this.snapshotTmpdir!;
	mkdirSync(root, { recursive: true });
	this.snapshotStore = new CountingSnapshotStore(
		new FilesystemSnapshotStore(join(root, "store"))
	);
	this.computerHosts = {};
});

Given("a computer host named {string}", function (this: ChatticusWorld, name: string): void {
	const root = this.snapshotTmpdir!;
	const liveRoot = join(root, "hosts", name);
	const store = this.snapshotStore as CountingSnapshotStore;
	this.computerHosts[name] = new ComputerHostDisk(liveRoot, store);
});

When("host {string} writes workspace file {string} containing {string}", function (
	this: ChatticusWorld,
	name: string,
	path: string,
	content: string
): void {
	const host = this.computerHosts[name] as ComputerHostDisk;
	host.writeWorkspaceFile(path, content);
});

When("host {string} writes browser profile file {string} containing {string}", function (
	this: ChatticusWorld,
	name: string,
	path: string,
	content: string
): void {
	const host = this.computerHosts[name] as ComputerHostDisk;
	host.writeBrowserProfileFile(path, content);
});

When(
	"host {string} publishes computer {string} for tenant {string} as worker {string}",
	async function (
		this: ChatticusWorld,
		name: string,
		computer_id: string,
		tenant_id: string,
		worker_id: string
	): Promise<void> {
		const host = this.computerHosts[name] as ComputerHostDisk;
		this.lastManifest = await host.publish({
			tenant_id,
			computer_id,
			worker_id,
		});
	}
);

When("host {string} hydrates computer {string} for tenant {string}", async function (
	this: ChatticusWorld,
	name: string,
	computer_id: string,
	tenant_id: string
): Promise<void> {
	const host = this.computerHosts[name] as ComputerHostDisk;
	await host.hydrate({ tenant_id, computer_id });
});

Then("the snapshot store has a pack for tenant {string} computer {string}", function (
	this: ChatticusWorld,
	tenant_id: string,
	computer_id: string
): void {
	const store = this.snapshotStore as CountingSnapshotStore;
	const uri = snapshotUri(tenant_id, computer_id);
	const packPath = join(
		store.inner.root,
		snapshotObjectDir(uri),
		PACK_FILENAME
	);
	if (!existsSync(packPath)) {
		throw new Error(`Pack file does not exist at ${packPath}`);
	}
	const stat = statSync(packPath);
	if (stat.size === 0) {
		throw new Error(`Pack file is empty at ${packPath}`);
	}
});

Then("host {string} has workspace file {string} containing {string}", function (
	this: ChatticusWorld,
	name: string,
	path: string,
	content: string
): void {
	const host = this.computerHosts[name] as ComputerHostDisk;
	const actual = host.readWorkspaceFile(path);
	if (actual !== content) {
		throw new Error(
			`Expected workspace file ${path} to contain ${JSON.stringify(content)}, ` +
			`but got ${JSON.stringify(actual)}`
		);
	}
});

Then("host {string} has browser profile file {string} containing {string}", function (
	this: ChatticusWorld,
	name: string,
	path: string,
	content: string
): void {
	const host = this.computerHosts[name] as ComputerHostDisk;
	const actual = host.readBrowserProfileFile(path);
	if (actual !== content) {
		throw new Error(
			`Expected browser profile file ${path} to contain ${JSON.stringify(content)}, ` +
			`but got ${JSON.stringify(actual)}`
		);
	}
});

Then("host {string} does not have workspace file {string}", function (
	this: ChatticusWorld,
	name: string,
	path: string
): void {
	const host = this.computerHosts[name] as ComputerHostDisk;
	const live = join(host.liveRoot, WORKSPACE_DIRNAME, path);
	if (existsSync(live)) {
		throw new Error(`Expected workspace file ${path} to not exist, but it does`);
	}
});

Then("the snapshot store served {int} pack download", function (
	this: ChatticusWorld,
	count: number
): void {
	const store = this.snapshotStore as CountingSnapshotStore;
	if (store.packDownloads !== count) {
		throw new Error(
			`Expected ${count} pack downloads, but got ${store.packDownloads}`
		);
	}
});
