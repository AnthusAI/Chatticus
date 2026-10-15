import { ComputerHostDisk } from "../src/snapshot/host.ts";
import { openSnapshotStore } from "../src/snapshot/store.ts";

/**
 * Administrator CLI: pack a host disk into the snapshot store, or hydrate.
 */
async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	if (argv.length === 0) {
		console.error("Usage: snapshot <command> [options]");
		console.error("");
		console.error("Commands:");
		console.error("  pack      Pack this host's live disk and write it to the store");
		console.error("  hydrate   Load the published snapshot onto this host's live disk");
		return 1;
	}

	const command = argv[0];

	if (command === "pack") {
		return await handlePack(argv.slice(1));
	}

	if (command === "hydrate") {
		return await handleHydrate(argv.slice(1));
	}

	console.error(`Unknown command: ${command}`);
	return 1;
}

/**
 * Parse arguments for the pack command.
 */
function parseCommonArgs(argv: string[]): { [key: string]: string | undefined } {
	const result: { [key: string]: string | undefined } = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (key.startsWith("--")) {
			result[key.slice(2)] = value;
		}
	}
	return result;
}

/**
 * Handle the pack command.
 */
async function handlePack(argv: string[]): Promise<number> {
	try {
		const args = parseCommonArgs(argv);

		const liveRoot = args["live-root"];
		const store = args.store;
		const tenant = args.tenant;
		const computer = args.computer;
		const worker = args.worker;

		if (!liveRoot) throw new Error("--live-root is required");
		if (!store) throw new Error("--store is required");
		if (!tenant) throw new Error("--tenant is required");
		if (!computer) throw new Error("--computer is required");
		if (!worker) throw new Error("--worker is required");

		const snapshotStore = await openSnapshotStore(store);
		const disk = new ComputerHostDisk(liveRoot, snapshotStore);

		const manifest = await disk.publish({
			tenant_id: tenant,
			computer_id: computer,
			worker_id: worker,
		});

		console.log(`Published ${manifest.checksum} for ${tenant}/${computer} as ${worker}`);
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		return 1;
	}
}

/**
 * Handle the hydrate command.
 */
async function handleHydrate(argv: string[]): Promise<number> {
	try {
		const args = parseCommonArgs(argv);

		const liveRoot = args["live-root"];
		const store = args.store;
		const tenant = args.tenant;
		const computer = args.computer;

		if (!liveRoot) throw new Error("--live-root is required");
		if (!store) throw new Error("--store is required");
		if (!tenant) throw new Error("--tenant is required");
		if (!computer) throw new Error("--computer is required");

		const snapshotStore = await openSnapshotStore(store);
		const disk = new ComputerHostDisk(liveRoot, snapshotStore);

		const manifest = await disk.hydrate({
			tenant_id: tenant,
			computer_id: computer,
		});

		console.log(`Hydrated ${manifest.checksum} for ${tenant}/${computer}`);
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		return 1;
	}
}

process.exit(await main());
