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
