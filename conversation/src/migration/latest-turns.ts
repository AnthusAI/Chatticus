import {
	type AttributeValue,
	ConditionalCheckFailedException,
	type DynamoDBClient,
	PutItemCommand,
	QueryCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { formatIsoDateTime } from "../store/codecs/util.ts";
import { turnPointerKey } from "../store/turn-store.ts";
import {
	type LegacyMessage,
	type LegacyTurn,
	type MigrationScope,
	listLegacyMessages,
	listLegacyTurns,
	readPointerTurnId,
	turnPartitionKeyOf,
} from "./legacy-layout.ts";

/** The reason recorded on a turn that was still active when the migration closed the old system. */
export const MIGRATION_INTERRUPTED_REASON = "interrupted_by_transcript_migration";

/** Dependencies of the turn conversion. */
export type TurnMigrationDependencies = {
	readonly client: DynamoDBClient;
	readonly messagingTableName: string;
	readonly clock: { now(): Date };
};

/** Options of one turn conversion. */
export type TurnConversionOptions = {
	/** Only report. */
	dryRun: boolean;
	/** Fail turns that are still active; only valid once the old system no longer writes. */
	failActive: boolean;
};

/** What the conversion did or would do for one channel. */
export type ChannelTurnReport = {
	tenantId: string;
	channelId: string;
	turns: number;
	converted: number;
	alreadyConverted: number;
	activeFailed: number;
	activeLeft: number;
	pointersWritten: number;
	dryRun: boolean;
};

const attribute = (item: Record<string, AttributeValue>, name: string): string | null => item[name]?.S || null;

async function completedMessageSeq(
	deps: TurnMigrationDependencies,
	turn: LegacyTurn,
	messages: () => Promise<LegacyMessage[]>,
): Promise<number | null> {
	const result = await deps.client.send(
		new QueryCommand({
			TableName: deps.messagingTableName,
			KeyConditionExpression: "pk = :pk AND begins_with(sk, :evt)",
			FilterExpression: "#kind = :completed",
			ExpressionAttributeNames: { "#kind": "kind" },
			ExpressionAttributeValues: {
				":pk": { S: turnPartitionKeyOf(turn.tenantId, turn.turnId) },
				":evt": { S: "evt#" },
				":completed": { S: "turn.completed" },
			},
			ConsistentRead: true,
		}),
	);
	for (const item of result.Items ?? []) {
		const seq = Number(item.message_seq?.N ?? "0");
		if (seq > 0) return seq;
	}
	const answer = (await messages()).find(
		(message) =>
			message.authorKind === "bot" &&
			message.authorId === turn.botId &&
			message.seq > (turn.promptMessageSeq ?? 0),
	);
	return answer?.seq ?? null;
}

async function convertTurn(
	deps: TurnMigrationDependencies,
	turn: LegacyTurn,
	messages: () => Promise<LegacyMessage[]>,
	options: TurnConversionOptions,
): Promise<"converted" | "already" | "failed-active" | "left-active"> {
	const active = turn.status === "active";
	if (active && !options.failActive) return "left-active";
	if (turn.item.migrated_at?.S !== undefined && !active) return "already";
	if (options.dryRun) return active ? "failed-active" : "converted";
	const promptAuthor =
		turn.promptMessageSeq === null
			? null
			: ((await messages()).find((message) => message.seq === turn.promptMessageSeq)?.authorId ?? null);
	const messageSeq = turn.status === "completed" ? await completedMessageSeq(deps, turn, messages) : null;
	const sets = ["migrated_at = :migratedAt"];
	const removes: string[] = [];
	const values: Record<string, AttributeValue> = {
		":migratedAt": { S: formatIsoDateTime(deps.clock.now()) },
	};
	const names: Record<string, string> = {};
	if (promptAuthor !== null && attribute(turn.item, "prompt_author_id") === null) {
		sets.push("prompt_author_id = :promptAuthor");
		values[":promptAuthor"] = { S: promptAuthor };
	}
	if (messageSeq !== null) {
		sets.push("message_seq = :messageSeq");
		values[":messageSeq"] = { N: String(messageSeq) };
	}
	let condition = "attribute_exists(pk)";
	if (active) {
		names["#status"] = "status";
		sets.push("#status = :failed", "terminal_reason = :reason");
		values[":failed"] = { S: "failed" };
		values[":reason"] = { S: MIGRATION_INTERRUPTED_REASON };
		values[":active"] = { S: "active" };
		removes.push("lease_expires_at", "claimed_by_worker_id", "waiting_for", "pending_computer_action_id", "pending_computer_tool_name");
		condition = "attribute_exists(pk) AND #status = :active";
	}
	try {
		await deps.client.send(
			new UpdateItemCommand({
				TableName: deps.messagingTableName,
				Key: { pk: { S: turnPartitionKeyOf(turn.tenantId, turn.turnId) }, sk: { S: "meta" } },
				UpdateExpression: `SET ${sets.join(", ")}${removes.length === 0 ? "" : ` REMOVE ${removes.join(", ")}`}`,
				ConditionExpression: condition,
				ExpressionAttributeNames: Object.keys(names).length === 0 ? undefined : names,
				ExpressionAttributeValues: values,
			}),
		);
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return "left-active";
		throw error;
	}
	return active ? "failed-active" : "converted";
}

async function putPointer(
	deps: TurnMigrationDependencies,
	key: { pk: string; sk: string },
	turn: LegacyTurn,
): Promise<boolean> {
	try {
		await deps.client.send(
			new PutItemCommand({
				TableName: deps.messagingTableName,
				Item: {
					pk: { S: key.pk },
					sk: { S: key.sk },
					tenant_id: { S: turn.tenantId },
					channel_id: { S: turn.channelId },
					bot_id: { S: turn.botId },
					turn_id: { S: turn.turnId },
					migrated: { BOOL: true },
				},
				ConditionExpression: "attribute_not_exists(pk) OR migrated = :migrated",
				ExpressionAttributeValues: { ":migrated": { BOOL: true } },
			}),
		);
		return true;
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return false;
		throw error;
	}
}

const promptOrder = (turn: LegacyTurn): number => turn.promptMessageSeq ?? -1;

/**
 * Rewrite the turn control records of every channel in scope into the new shape and give each channel its per-bot and
 * primary latest-turn pointers, so a reload after the flip still shows a failed turn and its reason. The record keeps its
 * key and every old attribute (additive update), which is why the old system can still read it until rollback ends.
 * A turn that is still `active` is failed with `interrupted_by_transcript_migration` when `failActive` is set, and
 * left untouched otherwise. Pointers written by the new system are never overwritten.
 *
 * @param deps Client, table and clock.
 * @param scope Tenant and channel filter.
 * @param options Dry run and fail-active flags.
 * @returns One report per channel that has turns.
 */
export async function convertLatestTurns(
	deps: TurnMigrationDependencies,
	scope: MigrationScope,
	options: TurnConversionOptions,
): Promise<ChannelTurnReport[]> {
	const store = { client: deps.client, tableName: deps.messagingTableName };
	const grouped = new Map<string, LegacyTurn[]>();
	for (const turn of await listLegacyTurns(store, scope)) {
		const key = `${turn.tenantId}\u0000${turn.channelId}`;
		grouped.set(key, [...(grouped.get(key) ?? []), turn]);
	}
	const reports: ChannelTurnReport[] = [];
	for (const key of [...grouped.keys()].sort()) {
		const turns = grouped.get(key)!;
		const { tenantId, channelId } = turns[0]!;
		let cached: Promise<LegacyMessage[]> | null = null;
		const messages = (): Promise<LegacyMessage[]> => {
			cached ??= listLegacyMessages(store, tenantId, channelId);
			return cached;
		};
		const report: ChannelTurnReport = {
			tenantId,
			channelId,
			turns: turns.length,
			converted: 0,
			alreadyConverted: 0,
			activeFailed: 0,
			activeLeft: 0,
			pointersWritten: 0,
			dryRun: options.dryRun,
		};
		const settled: LegacyTurn[] = [];
		const botsLeftActive = new Set<string>();
		for (const turn of turns) {
			const outcome = await convertTurn(deps, turn, messages, options);
			if (outcome === "converted") report.converted += 1;
			if (outcome === "already") report.alreadyConverted += 1;
			if (outcome === "failed-active") report.activeFailed += 1;
			if (outcome === "left-active") {
				report.activeLeft += 1;
				botsLeftActive.add(turn.botId);
			} else {
				settled.push(turn);
			}
		}
		const latestByBot = new Map<string, LegacyTurn>();
		for (const turn of settled) {
			if (botsLeftActive.has(turn.botId)) continue;
			const current = latestByBot.get(turn.botId);
			if (current === undefined || promptOrder(turn) >= promptOrder(current)) latestByBot.set(turn.botId, turn);
		}
		const pointedLatest = await readPointerTurnId(store, tenantId, channelId, "latest_turn");
		const candidates = [...latestByBot.values()];
		const primary =
			candidates.find((turn) => turn.turnId === pointedLatest) ??
			[...candidates].sort((left, right) => promptOrder(right) - promptOrder(left))[0];
		if (!options.dryRun) {
			for (const turn of candidates) {
				if (await putPointer(deps, turnPointerKey(tenantId, channelId, "latest", turn.botId), turn)) {
					report.pointersWritten += 1;
				}
			}
			if (primary !== undefined && (await putPointer(deps, turnPointerKey(tenantId, channelId, "latest", null), primary))) {
				report.pointersWritten += 1;
			}
		} else {
			report.pointersWritten = candidates.length + (primary === undefined ? 0 : 1);
		}
		reports.push(report);
	}
	return reports;
}
