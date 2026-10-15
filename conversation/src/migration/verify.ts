import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { Channel } from "../domain/channels.ts";
import { listChannelMessages } from "../pi/channel-listing.ts";
import { DynamoTurnControlStore, turnPointerKey } from "../store/turn-store.ts";
import {
	type MigrationDependencies,
	readSessionMessages,
	sessionChecksum,
} from "./copy.ts";
import {
	type LegacyMessage,
	type MigrationScope,
	listLegacyChannels,
	listLegacyMessages,
	readPointerTurnId,
	transcriptChecksum,
} from "./legacy-layout.ts";
import { MIGRATION_INTERRUPTED_REASON } from "./latest-turns.ts";
import { writeVerifiedMarker } from "./migration-state.ts";
import { formatIsoDateTime } from "../store/codecs/util.ts";

/** The outcome of comparing one channel's old items with what the new read paths serve. */
export type ChannelVerification = {
	tenantId: string;
	channelId: string;
	ok: boolean;
	legacyMessages: number;
	listedMessages: number;
	failures: string[];
};

const FIELDS: ReadonlyArray<[string, (message: LegacyMessage) => string | number | null]> = [
	["message_id", (message) => message.messageId],
	["author_kind", (message) => message.authorKind],
	["author_id", (message) => message.authorId],
	["body", (message) => message.body],
	["addressed_to_bot_id", (message) => message.addressedToBotId],
	["created_at", (message) => message.createdAt],
];

const expectedStatus = (legacyStatus: string): string => (legacyStatus === "active" ? "failed" : legacyStatus);

async function verifyLatestTurn(deps: MigrationDependencies, channel: Channel, failures: string[]): Promise<void> {
	const store = { client: deps.client, tableName: deps.messagingTableName };
	const turnId = await readPointerTurnId(store, channel.tenantId, channel.channelId, "latest_turn");
	if (turnId === null) return;
	const legacy = await deps.client.send(
		new GetItemCommand({
			TableName: deps.messagingTableName,
			Key: { pk: { S: `${channel.tenantId}#turn#${turnId}` }, sk: { S: "meta" } },
			ConsistentRead: true,
		}),
	);
	if (legacy.Item === undefined) {
		failures.push(`the latest turn ${turnId} named by the old pointer has no record`);
		return;
	}
	const turn = await new DynamoTurnControlStore(deps.client, deps.messagingTableName).getTurn(channel.tenantId, turnId);
	if (turn === null) {
		failures.push(`the latest turn ${turnId} cannot be read`);
		return;
	}
	const legacyStatus = legacy.Item.status!.S!;
	if (turn.status !== expectedStatus(legacyStatus)) {
		failures.push(`latest turn ${turnId} is ${turn.status}, expected ${expectedStatus(legacyStatus)}`);
	}
	const legacyReason = legacy.Item.terminal_reason?.S || null;
	const expectedReason = legacyStatus === "active" ? MIGRATION_INTERRUPTED_REASON : legacyReason;
	if (turn.terminalReason !== expectedReason) {
		failures.push(`latest turn ${turnId} has reason ${turn.terminalReason}, expected ${expectedReason}`);
	}
	const botPointer = turnPointerKey(channel.tenantId, channel.channelId, "latest", turn.botId);
	const pointer = await deps.client.send(
		new GetItemCommand({
			TableName: deps.messagingTableName,
			Key: { pk: { S: botPointer.pk }, sk: { S: botPointer.sk } },
			ConsistentRead: true,
		}),
	);
	if (pointer.Item === undefined) failures.push(`bot ${turn.botId} has no latest turn pointer`);
	const primary = turnPointerKey(channel.tenantId, channel.channelId, "latest", null);
	const primaryPointer = await deps.client.send(
		new GetItemCommand({
			TableName: deps.messagingTableName,
			Key: { pk: { S: primary.pk }, sk: { S: primary.sk } },
			ConsistentRead: true,
		}),
	);
	if (primaryPointer.Item === undefined) failures.push("the channel has no primary latest turn pointer");
}

/**
 * Compare one channel's old items with the new read paths: every bot session holds every old message in order with the
 * same checksum, `GET messages` (the production listing over the sessions and mailboxes) returns the same count, order,
 * seqs, authors, bodies, addressees and timestamps, and the latest turn shows its old status and reason.
 *
 * @param deps Clients and tables.
 * @param channel The channel.
 * @returns The comparison; `ok` is false when any failure is listed. A passing channel also gets its `VERIFIED#` marker,
 * the only thing the day-14 purge trusts.
 */
export async function verifyChannel(deps: MigrationDependencies, channel: Channel): Promise<ChannelVerification> {
	const legacy = await listLegacyMessages(
		{ client: deps.client, tableName: deps.messagingTableName },
		channel.tenantId,
		channel.channelId,
	);
	const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	const failures: string[] = [];
	if (botIds.length === 0 && legacy.length > 0) {
		failures.push("the channel has old messages but no bot session to serve them");
	}
	const expected = transcriptChecksum(legacy);
	const legacyIds = new Set(legacy.map((message) => message.messageId));
	for (const botId of botIds) {
		const held = (await readSessionMessages(deps, channel.tenantId, botId, channel.channelId)).filter((message) =>
			legacyIds.has(message.messageId),
		);
		if (held.length !== legacy.length) {
			failures.push(`session of bot ${botId} holds ${held.length} of ${legacy.length} old messages`);
			continue;
		}
		for (let index = 1; index < held.length; index += 1) {
			if (held[index]!.seq <= held[index - 1]!.seq) {
				failures.push(`session of bot ${botId} has message seq ${held[index]!.seq} after seq ${held[index - 1]!.seq}`);
				break;
			}
		}
		if (sessionChecksum(held) !== expected) failures.push(`session of bot ${botId} does not match the old transcript`);
	}
	const lastLegacySeq = legacy.length === 0 ? 0 : legacy[legacy.length - 1]!.seq;
	const listed = (
		await listChannelMessages(
			{
				client: deps.client,
				s3: deps.s3,
				messagingTableName: deps.messagingTableName,
				conversationsTableName: deps.conversationsTableName,
				bucket: deps.bucket,
			},
			channel.tenantId,
			channel.channelId,
			botIds,
			0,
		)
	).filter((message) => message.seq <= lastLegacySeq);
	if (listed.length !== legacy.length) {
		failures.push(`the message listing returns ${listed.length} messages, the old items hold ${legacy.length}`);
	} else {
		legacy.forEach((message, index) => {
			const shown = listed[index]!;
			if (shown.seq !== message.seq) failures.push(`listing position ${index + 1} has seq ${shown.seq}, expected ${message.seq}`);
			const shownFields: Record<string, string | number | null> = {
				message_id: shown.message_id,
				author_kind: shown.author_kind,
				author_id: shown.author_id,
				body: shown.body,
				addressed_to_bot_id: shown.addressed_to_bot_id,
				created_at: shown.created_at,
			};
			for (const [name, read] of FIELDS) {
				if (shownFields[name] !== read(message)) failures.push(`message seq ${message.seq} differs in ${name}`);
			}
		});
	}
	await verifyLatestTurn(deps, channel, failures);
	if (failures.length === 0) {
		await writeVerifiedMarker(deps.client, deps.messagingTableName, {
			tenantId: channel.tenantId,
			channelId: channel.channelId,
			verifiedThroughSeq: lastLegacySeq,
			messageCount: legacy.length,
			checksum: expected,
			verifiedAt: formatIsoDateTime(deps.clock.now()),
		});
	}
	return {
		tenantId: channel.tenantId,
		channelId: channel.channelId,
		ok: failures.length === 0,
		legacyMessages: legacy.length,
		listedMessages: listed.length,
		failures,
	};
}

/**
 * Verify every channel in scope.
 *
 * @param deps Clients and tables.
 * @param scope Tenant and channel filter.
 * @returns One comparison per channel.
 */
export async function verifyAll(deps: MigrationDependencies, scope: MigrationScope): Promise<ChannelVerification[]> {
	const channels = await listLegacyChannels({ client: deps.client, tableName: deps.messagingTableName }, scope);
	const results: ChannelVerification[] = [];
	for (const channel of channels) results.push(await verifyChannel(deps, channel));
	return results;
}
