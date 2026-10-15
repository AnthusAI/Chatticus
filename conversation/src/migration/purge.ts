import { BatchWriteItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { messageSortKey } from "../store/codecs/channel.ts";
import {
	type MigrationScope,
	channelPartitionKey,
	listLegacyChannels,
	listLegacyMessages,
	transcriptChecksum,
} from "./legacy-layout.ts";
import { readVerifiedMarker } from "./migration-state.ts";

/** Days a channel's verified marker must have stood before its old message items may be purged. */
export const DEFAULT_PURGE_MINIMUM_AGE_DAYS = 14;

/** What the purge reads and deletes. */
export type PurgeDependencies = {
	readonly client: DynamoDBClient;
	readonly messagingTableName: string;
	readonly clock: { now(): Date };
};

/** Options of one purge pass. */
export type PurgeOptions = {
	/** Delete for real; without it the pass only reports. */
	readonly execute: boolean;
	/** Minimum age of the verified marker, in days. */
	readonly minimumAgeDays: number;
};

/** What happened, or would happen, to one channel. */
export type ChannelPurge = {
	readonly tenantId: string;
	readonly channelId: string;
	readonly outcome: "purged" | "would_purge" | "skipped";
	/** Old message items deleted, or that would be. */
	readonly items: number;
	/** Why a channel was skipped. */
	readonly reason?: string;
};

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const BATCH_DELETE_LIMIT = 25;

async function deleteMessageItems(
	deps: PurgeDependencies,
	tenantId: string,
	channelId: string,
	sequences: readonly number[],
): Promise<void> {
	const partitionKey = channelPartitionKey(tenantId, channelId);
	for (let start = 0; start < sequences.length; start += BATCH_DELETE_LIMIT) {
		let pending = sequences.slice(start, start + BATCH_DELETE_LIMIT).map((seq) => ({
			DeleteRequest: { Key: { pk: { S: partitionKey }, sk: { S: messageSortKey(seq) } } },
		}));
		while (pending.length > 0) {
			const response = await deps.client.send(
				new BatchWriteItemCommand({ RequestItems: { [deps.messagingTableName]: pending } }),
			);
			pending = (response.UnprocessedItems?.[deps.messagingTableName] ?? []) as typeof pending;
		}
	}
}

/**
 * Delete the Python-era message items of channels the migration verified, at least `minimumAgeDays` after that
 * verification. A channel is touched only when its `VERIFIED#` marker exists, is old enough, and the old items at or
 * below the verified sequence still hash to the marker's checksum; nothing above that sequence (anything the new system
 * wrote) is ever deleted, and no item other than a message item is. Without `execute` nothing is deleted.
 *
 * @param deps Client, the Messaging table and the clock.
 * @param scope Tenant and channel filter.
 * @param options Whether to delete and how old the marker must be.
 * @returns One entry per channel in scope.
 */
export async function purgeLegacyItems(
	deps: PurgeDependencies,
	scope: MigrationScope,
	options: PurgeOptions,
): Promise<ChannelPurge[]> {
	const store = { client: deps.client, tableName: deps.messagingTableName };
	const results: ChannelPurge[] = [];
	for (const channel of await listLegacyChannels(store, scope)) {
		const { tenantId, channelId } = channel;
		const skipped = (reason: string): ChannelPurge => ({ tenantId, channelId, outcome: "skipped", items: 0, reason });
		const marker = await readVerifiedMarker(deps.client, deps.messagingTableName, tenantId, channelId);
		if (marker === null) {
			results.push(skipped("no verified marker"));
			continue;
		}
		const ageDays = (deps.clock.now().getTime() - new Date(marker.verifiedAt).getTime()) / MILLISECONDS_PER_DAY;
		if (!(ageDays >= options.minimumAgeDays)) {
			results.push(skipped(`verified ${ageDays.toFixed(1)} days ago, needs ${options.minimumAgeDays}`));
			continue;
		}
		const covered = (await listLegacyMessages(store, tenantId, channelId)).filter(
			(message) => message.seq <= marker.verifiedThroughSeq,
		);
		if (covered.length !== marker.messageCount || transcriptChecksum(covered) !== marker.checksum) {
			results.push(skipped("the old items no longer match the verified marker"));
			continue;
		}
		if (options.execute) await deleteMessageItems(deps, tenantId, channelId, covered.map((message) => message.seq));
		results.push({ tenantId, channelId, outcome: options.execute ? "purged" : "would_purge", items: covered.length });
	}
	return results;
}
