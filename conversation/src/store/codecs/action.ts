/**
 * Codec for the durable computer action: the record that answers whether a parked computer tool call was ever run.
 * Two items hold one action: `{tenant}#computer#actions` / `act#{action_id}` is the record, and
 * `{tenant}#turn#{turn}` / `act#{call_id}` is the index a resumed turn uses to find it by the Pi tool call id.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { computerActionKey, turnActionIndexKey } from "../keys.ts";

/** Where an action is: asked for, held by a host under a lease, or answered. */
export type ComputerActionStatus = "requested" | "claimed" | "done";

/** What the host is allowed to do for one action, written by the executor after the policy decided. */
export type ActionEnvelope = {
	readonly tool: string;
	/** Whether running the action twice is harmless, so a lost host may simply run it again. */
	readonly idempotent: boolean;
	readonly path?: string;
	readonly cwd?: string;
	readonly origin?: string;
};

/** One computer tool call of one turn. */
export type ComputerAction = {
	readonly actionId: string;
	readonly tenantId: string;
	readonly computerId: string;
	readonly turnId: string;
	readonly channelId: string;
	readonly botId: string;
	/** The acting member, whose standing bounded the call. */
	readonly userId: string | null;
	readonly callId: string;
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, string>>;
	/** The readiness gate the turn waits on: `workspace` or `browser`. */
	readonly gate: string;
	readonly envelope: ActionEnvelope;
	readonly status: ComputerActionStatus;
	readonly claimedBy: string | null;
	readonly leaseExpiresAt: Date | null;
	readonly result: string | null;
	readonly resultIsError: boolean;
	readonly createdAt: Date;
	readonly completedAt: Date | null;
};

type Item = Record<string, AttributeValue>;

const epochSeconds = (moment: Date): string => String(Math.floor(moment.getTime() / 1000));

const optionalString = (item: Item, name: string): string | null => {
	const value = item[name]?.S;
	return value !== undefined && value !== "" ? value : null;
};

const optionalDate = (item: Item, name: string): Date | null => {
	const value = item[name]?.N;
	return value === undefined ? null : new Date(Number(value) * 1000);
};

/**
 * Encode an action to its record item.
 *
 * @param action The action.
 * @returns The DynamoDB item.
 */
export function encodeAction(action: ComputerAction): Item {
	const key = computerActionKey(action.tenantId, action.actionId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		action_id: { S: action.actionId },
		tenant_id: { S: action.tenantId },
		computer_id: { S: action.computerId },
		turn_id: { S: action.turnId },
		channel_id: { S: action.channelId },
		bot_id: { S: action.botId },
		call_id: { S: action.callId },
		tool_name: { S: action.toolName },
		arguments: { S: JSON.stringify(action.arguments) },
		gate: { S: action.gate },
		envelope: { S: JSON.stringify(action.envelope) },
		status: { S: action.status },
		result_is_error: { BOOL: action.resultIsError },
		created_at: { N: epochSeconds(action.createdAt) },
	};
	if (action.userId !== null) item.user_id = { S: action.userId };
	if (action.claimedBy !== null) item.claimed_by = { S: action.claimedBy };
	if (action.leaseExpiresAt !== null) item.lease_expires_at = { N: epochSeconds(action.leaseExpiresAt) };
	if (action.result !== null) item.result = { S: action.result };
	if (action.completedAt !== null) item.completed_at = { N: epochSeconds(action.completedAt) };
	return item;
}

/**
 * Decode an action from its record item.
 *
 * @param item The DynamoDB item.
 * @returns The action.
 * @throws Error If a required attribute is missing.
 */
export function decodeAction(item: Item): ComputerAction {
	const required = (name: string): string => {
		const value = item[name]?.S;
		if (value === undefined) throw new Error(`malformed computer action item: ${name}`);
		return value;
	};
	return {
		actionId: required("action_id"),
		tenantId: required("tenant_id"),
		computerId: required("computer_id"),
		turnId: required("turn_id"),
		channelId: required("channel_id"),
		botId: required("bot_id"),
		userId: optionalString(item, "user_id"),
		callId: required("call_id"),
		toolName: required("tool_name"),
		arguments: JSON.parse(required("arguments")) as Record<string, string>,
		gate: required("gate"),
		envelope: JSON.parse(required("envelope")) as ActionEnvelope,
		status: required("status") as ComputerActionStatus,
		claimedBy: optionalString(item, "claimed_by"),
		leaseExpiresAt: optionalDate(item, "lease_expires_at"),
		result: optionalString(item, "result"),
		resultIsError: item.result_is_error?.BOOL ?? false,
		createdAt: optionalDate(item, "created_at") ?? new Date(0),
		completedAt: optionalDate(item, "completed_at"),
	};
}

/**
 * The index item that points a turn's tool call at its action.
 *
 * @param action The action.
 * @returns The DynamoDB item.
 */
export function encodeActionIndex(action: ComputerAction): Item {
	const key = turnActionIndexKey(action.tenantId, action.turnId, action.callId);
	return {
		pk: { S: key.pk },
		sk: { S: key.sk },
		action_id: { S: action.actionId },
		tenant_id: { S: action.tenantId },
		turn_id: { S: action.turnId },
		call_id: { S: action.callId },
	};
}
