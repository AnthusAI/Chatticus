/**
 * Codecs for Computer items.
 * Ported from python/src/chatticus/messaging/store.py lines 2843-2876, 2816-2841.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Computer {
	computerId: string;
	tenantId: string;
	policy: string;
	stopped: boolean;
	modelReady: boolean;
	workspaceReady: boolean;
	browserReady: boolean;
	hostStartGeneration: number;
	hostStartDispatchedGeneration: number;
	snapshotGeneration: number;
	diskDirty: boolean;
	hydrateRequired: boolean;
	hostStartLeaseExpiresAt?: Date;
	snapshotUri?: string;
	snapshotChecksum?: string;
	intendedHostWorkerId?: string;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode a Computer to a DynamoDB item.
 * @param value Computer to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Computer): Item {
	const item: Item = {
		pk: { S: `${value.tenantId}#computer#${value.computerId}` },
		sk: { S: "meta" },
		tenant_id: { S: value.tenantId },
		computer_id: { S: value.computerId },
		stopped: { BOOL: value.stopped },
		policy: { S: value.policy },
		model_ready: { BOOL: value.modelReady },
		workspace_ready: { BOOL: value.workspaceReady },
		browser_ready: { BOOL: value.browserReady },
		host_start_generation: { N: String(value.hostStartGeneration) },
		host_start_dispatched_generation: { N: String(value.hostStartDispatchedGeneration) },
		host_start_lease_expires_at: { N: String(
			value.hostStartLeaseExpiresAt
				? Math.floor(value.hostStartLeaseExpiresAt.getTime() / 1000)
				: 0
		) },
		snapshot_generation: { N: String(value.snapshotGeneration) },
		disk_dirty: { BOOL: value.diskDirty },
		hydrate_required: { BOOL: value.hydrateRequired },
	};

	if (value.snapshotUri !== undefined) {
		item.snapshot_uri = { S: value.snapshotUri };
	}
	if (value.snapshotChecksum !== undefined) {
		item.snapshot_checksum = { S: value.snapshotChecksum };
	}
	if (value.intendedHostWorkerId !== undefined) {
		item.intended_host_worker_id = { S: value.intendedHostWorkerId };
	}

	return item;
}

/**
 * Decode a Computer from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Computer.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Computer {
	const computerId = item.computer_id?.S;
	if (!computerId) {
		throw new Error("malformed computer item: computer_id");
	}

	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed computer item: tenant_id");
	}

	const policy = item.policy?.S;
	if (!policy) {
		throw new Error("malformed computer item: policy");
	}

	const stopped = item.stopped?.BOOL ?? false;
	const modelReady = item.model_ready?.BOOL ?? true;
	const workspaceReady = item.workspace_ready?.BOOL ?? false;
	const browserReady = item.browser_ready?.BOOL ?? false;

	const hostStartGeneration = item.host_start_generation?.N
		? Number(item.host_start_generation.N)
		: 0;
	const hostStartDispatchedGeneration = item.host_start_dispatched_generation?.N
		? Number(item.host_start_dispatched_generation.N)
		: 0;

	const leaseEpoch = item.host_start_lease_expires_at?.N
		? Number(item.host_start_lease_expires_at.N)
		: 0;

	const snapshotGeneration = item.snapshot_generation?.N
		? Number(item.snapshot_generation.N)
		: 0;

	const diskDirty = item.disk_dirty?.BOOL ?? false;
	const hydrateRequired = item.hydrate_required?.BOOL ?? false;

	return {
		computerId,
		tenantId,
		policy,
		stopped,
		modelReady,
		workspaceReady,
		browserReady,
		hostStartGeneration,
		hostStartDispatchedGeneration,
		snapshotGeneration,
		diskDirty,
		hydrateRequired,
		hostStartLeaseExpiresAt: leaseEpoch ? new Date(leaseEpoch * 1000) : undefined,
		snapshotUri: item.snapshot_uri?.S,
		snapshotChecksum: item.snapshot_checksum?.S,
		intendedHostWorkerId: item.intended_host_worker_id?.S,
	};
}
