/**
 * Codecs for Bot items.
 * Ported from python/src/chatticus/messaging/store.py lines 1614-1680, 2798-2813.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { stringifyPythonStyle } from "./util.ts";

export interface Bot {
	botId: string;
	tenantId: string;
	name: string;
	memory: Record<string, string>;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode a Bot to a DynamoDB item.
 * @param value Bot to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Bot): Item {
	return {
		pk: { S: `${value.tenantId}#roster` },
		sk: { S: `bot#${value.botId}` },
		tenant_id: { S: value.tenantId },
		bot_id: { S: value.botId },
		name: { S: value.name },
		memory: { S: stringifyPythonStyle(value.memory) },
	};
}

/**
 * Decode a Bot from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Bot.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Bot {
	const botId = item.bot_id?.S;
	if (!botId) {
		throw new Error("malformed bot item: bot_id");
	}

	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed bot item: tenant_id");
	}

	const name = item.name?.S;
	if (!name) {
		throw new Error("malformed bot item: name");
	}

	const memoryRaw = item.memory?.S ?? "{}";
	let memory: Record<string, string> = {};
	try {
		const parsed = JSON.parse(memoryRaw);
		if (typeof parsed === "object" && parsed !== null) {
			memory = Object.fromEntries(
				Object.entries(parsed).map(([key, val]) => [String(key), String(val)])
			);
		}
	} catch {
		memory = {};
	}

	return {
		botId,
		tenantId,
		name,
		memory,
	};
}
