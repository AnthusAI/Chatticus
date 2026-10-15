import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, type Extension, Harness, type HarnessOptions, type HarnessSettings } from "@earendil-works/pi-durable";
import { IndexedStorage, type SnapshotPolicy } from "../storage/indexed-storage.ts";

export type OwnerStorageDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly tableName: string;
	readonly bucket: string;
	/** When this owner writes snapshot objects; unset means never. */
	readonly snapshotPolicy?: SnapshotPolicy;
};

export type OwnerSessionDependencies = OwnerStorageDependencies & {
	readonly models: Models;
	readonly extensions: readonly Extension[];
	readonly context: Context;
	/** Harness run policy, such as the retry policy of a failed model call. */
	readonly settings?: HarnessSettings;
	/** Builds the execution environment Pi's own tools run in, for an owner that runs them; absent for an owner that does not. */
	readonly env?: HarnessOptions["env"];
};

export type OwnerSession = {
	readonly harness: Harness;
	readonly storage: IndexedStorage;
	readonly fence: number;
	close(): Promise<void>;
};

/**
 * Allocate a fresh fence for the session and open its storage under that fence.
 *
 * @param storageId Partition identity, `tenant#bot#channel`.
 * @param dependencies Clients, table and bucket.
 * @returns The fenced storage and the fence it holds.
 */
export async function openOwnerStorage(
	storageId: string,
	dependencies: OwnerStorageDependencies,
): Promise<{ storage: IndexedStorage; fence: number }> {
	const fence = await IndexedStorage.allocateFence(dependencies.client, dependencies.tableName, storageId);
	const storage = await IndexedStorage.open({ ...dependencies, storageId, fence });
	return { storage, fence };
}

/**
 * Open one owner of a bot-channel Pi session: fenced storage plus a Harness with the Chatticus extensions installed.
 * Closing the session closes the Harness (which closes the storage) with the abort signal removed, so a cancelled
 * turn still shuts down cleanly.
 *
 * @param storageId Partition identity, `tenant#bot#channel`.
 * @param dependencies Storage dependencies, models, extensions and the turn context.
 * @returns The open owner session.
 */
export async function openOwnerSession(storageId: string, dependencies: OwnerSessionDependencies): Promise<OwnerSession> {
	const { storage, fence } = await openOwnerStorage(storageId, dependencies);
	const registry = createRegistry();
	for (const extension of dependencies.extensions) registry.install(extension);
	const harness = await Harness.open(
		storage,
		{ models: dependencies.models, registry, settings: dependencies.settings, env: dependencies.env },
		dependencies.context,
	);
	return {
		harness,
		storage,
		fence,
		close: () => harness.close(withoutAbortSignal(dependencies.context)),
	};
}
