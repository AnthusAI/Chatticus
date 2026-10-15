import {
	type AttributeValue,
	type DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { formatIsoDateTime } from "../store/codecs/util.ts";

/** The write gate the front door honors: `MIGRATING` refuses every write route with 503, `OPEN` serves normally. */
export type WriteGateState = "MIGRATING" | "OPEN";

/** What the HTTP application asks before it serves a write route. */
export interface WriteGate {
	/** Whether writes are refused right now. */
	isClosed(): Promise<boolean>;
}

/** The message a refused write carries. */
export const WRITE_GATE_MESSAGE =
	"Chatticus is moving its conversation history and is read-only for a few minutes. Reads still work. Try again shortly.";

/** Seconds a client is told to wait before retrying a refused write. */
export const WRITE_GATE_RETRY_AFTER_SECONDS = 30;

/** Key of the gate state item in the Messaging table. */
export const WRITE_GATE_KEY = { pk: "MIGRATION", sk: "write_gate" } as const;

/** The Messaging table implementation of the write gate. A missing item means `OPEN`. */
export class DynamoWriteGate implements WriteGate {
	private readonly client: DynamoDBClient;
	private readonly tableName: string;

	/**
	 * @param client DynamoDB client.
	 * @param tableName The Messaging table.
	 */
	constructor(client: DynamoDBClient, tableName: string) {
		this.client = client;
		this.tableName = tableName;
	}

	/** The stored state, `OPEN` when none was ever written. */
	async state(): Promise<WriteGateState> {
		const result = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: WRITE_GATE_KEY.pk }, sk: { S: WRITE_GATE_KEY.sk } },
				ConsistentRead: true,
			}),
		);
		return result.Item?.state?.S === "MIGRATING" ? "MIGRATING" : "OPEN";
	}

	async isClosed(): Promise<boolean> {
		return (await this.state()) === "MIGRATING";
	}

	/**
	 * Set the gate state.
	 *
	 * @param state The new state.
	 * @param now The time of the change, recorded on the item.
	 */
	async set(state: WriteGateState, now: Date): Promise<void> {
		await this.client.send(
			new PutItemCommand({
				TableName: this.tableName,
				Item: {
					pk: { S: WRITE_GATE_KEY.pk },
					sk: { S: WRITE_GATE_KEY.sk },
					state: { S: state },
					changed_at: { S: formatIsoDateTime(now) },
				},
			}),
		);
	}
}

/** Longest time a read of the gate state is reused, so `gate open` takes effect within this window. */
export const WRITE_GATE_CACHE_MILLISECONDS = 2000;

/** Wraps a gate with a short cache and fails closed: a gate that cannot be read refuses writes. */
export class CachedFailClosedWriteGate implements WriteGate {
	private readonly inner: WriteGate;
	private readonly clock: { now(): Date };
	private cached: { closed: boolean; readAtMilliseconds: number } | null = null;

	/**
	 * @param inner The gate read from the table.
	 * @param clock Time source.
	 */
	constructor(inner: WriteGate, clock: { now(): Date }) {
		this.inner = inner;
		this.clock = clock;
	}

	async isClosed(): Promise<boolean> {
		const nowMilliseconds = this.clock.now().getTime();
		if (this.cached !== null && nowMilliseconds - this.cached.readAtMilliseconds < WRITE_GATE_CACHE_MILLISECONDS) {
			return this.cached.closed;
		}
		try {
			const closed = await this.inner.isClosed();
			this.cached = { closed, readAtMilliseconds: nowMilliseconds };
			return closed;
		} catch {
			this.cached = null;
			return true;
		}
	}
}

/** What the copy knows about one (channel, session) after its last pass. */
export type SessionMarker = {
	tenantId: string;
	channelId: string;
	botId: string;
	/** The highest old sequence the session holds. */
	lastSeq: number;
	/** How many old messages the session holds. */
	messageCount: number;
	/** Checksum of the old transcript the session was verified against. */
	checksum: string;
	/** `copy` or `delta`, the phase of the pass that last wrote. */
	phase: "copy" | "delta";
	updatedAt: string;
};

/**
 * Key of the `MIGRATED#` marker of one (channel, session).
 *
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @returns The marker item key.
 */
export const markerKey = (tenantId: string, botId: string, channelId: string): { pk: string; sk: string } => ({
	pk: `MIGRATED#${tenantId}#${botId}#${channelId}`,
	sk: "marker",
});

/**
 * Read the marker of a session.
 *
 * @param client DynamoDB client.
 * @param tableName The Messaging table.
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @returns The marker, or null when the session was never copied.
 */
export async function readMarker(
	client: DynamoDBClient,
	tableName: string,
	tenantId: string,
	botId: string,
	channelId: string,
): Promise<SessionMarker | null> {
	const key = markerKey(tenantId, botId, channelId);
	const result = await client.send(
		new GetItemCommand({ TableName: tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } }, ConsistentRead: true }),
	);
	const item = result.Item;
	if (item === undefined) return null;
	return {
		tenantId,
		channelId,
		botId,
		lastSeq: Number(item.last_seq!.N),
		messageCount: Number(item.message_count!.N),
		checksum: item.checksum!.S!,
		phase: item.phase!.S === "delta" ? "delta" : "copy",
		updatedAt: item.updated_at!.S!,
	};
}

/**
 * Write the marker of a session.
 *
 * @param client DynamoDB client.
 * @param tableName The Messaging table.
 * @param marker The marker.
 */
export async function writeMarker(client: DynamoDBClient, tableName: string, marker: SessionMarker): Promise<void> {
	const key = markerKey(marker.tenantId, marker.botId, marker.channelId);
	const item: Record<string, AttributeValue> = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: marker.tenantId },
		channel_id: { S: marker.channelId },
		bot_id: { S: marker.botId },
		last_seq: { N: String(marker.lastSeq) },
		message_count: { N: String(marker.messageCount) },
		checksum: { S: marker.checksum },
		phase: { S: marker.phase },
		updated_at: { S: marker.updatedAt },
	};
	await client.send(new PutItemCommand({ TableName: tableName, Item: item }));
}

/** What a passing verification of one channel proved about the old message items. */
export type VerifiedMarker = {
	tenantId: string;
	channelId: string;
	/** The highest old message sequence the verification covered; nothing above it is ever a purge candidate. */
	verifiedThroughSeq: number;
	/** How many old messages the verification covered. */
	messageCount: number;
	/** Checksum of exactly those old messages. */
	checksum: string;
	/** When the verification passed. */
	verifiedAt: string;
};

/**
 * Key of the `VERIFIED#` marker of one channel.
 *
 * @param tenantId Organization.
 * @param channelId Channel.
 * @returns The marker item key.
 */
export const verifiedMarkerKey = (tenantId: string, channelId: string): { pk: string; sk: string } => ({
	pk: `VERIFIED#${tenantId}#${channelId}`,
	sk: "marker",
});

/**
 * Write the verified marker of a channel, replacing an older one.
 *
 * @param client DynamoDB client.
 * @param tableName The Messaging table.
 * @param marker The marker.
 */
export async function writeVerifiedMarker(client: DynamoDBClient, tableName: string, marker: VerifiedMarker): Promise<void> {
	const key = verifiedMarkerKey(marker.tenantId, marker.channelId);
	await client.send(
		new PutItemCommand({
			TableName: tableName,
			Item: {
				pk: { S: key.pk },
				sk: { S: key.sk },
				tenant_id: { S: marker.tenantId },
				channel_id: { S: marker.channelId },
				verified_through_seq: { N: String(marker.verifiedThroughSeq) },
				message_count: { N: String(marker.messageCount) },
				checksum: { S: marker.checksum },
				verified_at: { S: marker.verifiedAt },
			},
		}),
	);
}

/**
 * Read the verified marker of a channel.
 *
 * @param client DynamoDB client.
 * @param tableName The Messaging table.
 * @param tenantId Organization.
 * @param channelId Channel.
 * @returns The marker, or null when the channel never passed verification.
 */
export async function readVerifiedMarker(
	client: DynamoDBClient,
	tableName: string,
	tenantId: string,
	channelId: string,
): Promise<VerifiedMarker | null> {
	const key = verifiedMarkerKey(tenantId, channelId);
	const result = await client.send(
		new GetItemCommand({ TableName: tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } }, ConsistentRead: true }),
	);
	const item = result.Item;
	if (item === undefined) return null;
	return {
		tenantId,
		channelId,
		verifiedThroughSeq: Number(item.verified_through_seq!.N),
		messageCount: Number(item.message_count!.N),
		checksum: item.checksum!.S!,
		verifiedAt: item.verified_at!.S!,
	};
}
