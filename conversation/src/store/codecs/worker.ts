/**
 * Codecs for Worker items.
 * Ported from python/src/chatticus/messaging/store.py lines 3128-3168.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Worker {
	workerId: string;
	tenantId: string;
	costClass: string;
	capabilities: string[];
	tokenHash: string;
	lastHeartbeatAt: Date;
	computerId?: string;
	hydratedSnapshotGeneration?: number;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode a Worker to a DynamoDB item.
 * @param value Worker to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Worker): Item {
	const item: Item = {
		pk: { S: `${value.tenantId}#roster` },
		sk: { S: `worker#${value.workerId}` },
		worker_id: { S: value.workerId },
		tenant_id: { S: value.tenantId },
		cost_class: { S: value.costClass },
		capabilities: { S: JSON.stringify(value.capabilities.sort()) },
		token_hash: { S: value.tokenHash },
		last_heartbeat_at: { S: value.lastHeartbeatAt.toISOString() },
	};

	if (value.computerId !== undefined) {
		item.computer_id = { S: value.computerId };
	}
	if (value.hydratedSnapshotGeneration !== undefined) {
		item.hydrated_snapshot_generation = { N: String(value.hydratedSnapshotGeneration) };
	}

	return item;
}

/**
 * Decode a Worker from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Worker.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Worker {
	const workerId = item.worker_id?.S;
	if (!workerId) {
		throw new Error("malformed worker item: worker_id");
	}

	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed worker item: tenant_id");
	}

	const costClass = item.cost_class?.S;
	if (!costClass) {
		throw new Error("malformed worker item: cost_class");
	}

	const capabilitiesStr = item.capabilities?.S ?? "[]";
	let capabilities: string[] = [];
	try {
		const parsed = JSON.parse(capabilitiesStr);
		if (Array.isArray(parsed)) {
			capabilities = parsed.map(String);
		}
	} catch {
		capabilities = [];
	}

	const tokenHash = item.token_hash?.S;
	if (!tokenHash) {
		throw new Error("malformed worker item: token_hash");
	}

	const lastHeartbeatAtStr = item.last_heartbeat_at?.S;
	if (!lastHeartbeatAtStr) {
		throw new Error("malformed worker item: last_heartbeat_at");
	}

	const hydratedStr = item.hydrated_snapshot_generation?.N;

	return {
		workerId,
		tenantId,
		costClass,
		capabilities,
		tokenHash,
		lastHeartbeatAt: new Date(lastHeartbeatAtStr),
		computerId: item.computer_id?.S,
		hydratedSnapshotGeneration: hydratedStr ? Number(hydratedStr) : undefined,
	};
}
