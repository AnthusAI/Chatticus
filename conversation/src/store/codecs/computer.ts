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
	/** The host reported that this computer's image has no browser; cleared when a host starts or reports the browser ready. */
	browserUnavailable?: boolean;
	hostStartGeneration: number;
	hostStartDispatchedGeneration: number;
	snapshotGeneration: number;
	diskDirty: boolean;
	hydrateRequired: boolean;
	hostStartLeaseExpiresAt?: Date;
	snapshotUri?: string;
	snapshotChecksum?: string;
	intendedHostWorkerId?: string;
	/** The one host holding the right to write the live disk, until the next host start generation clears it. */
	liveWriterHostId?: string;
	/** When the control plane found the host of this computer gone and settled its record; the unpublished writes were lost. */
	hostLostAt?: Date;
	/** The host start generation whose host was found gone. */
	hostLostGeneration?: number;
	/** The id of the live owner that exchanged its bootstrap token; cleared when the owner stops or a new generation is claimed. */
	ownerId?: string;
	/** The host start generation of the last owner that exchanged a bootstrap token. Never cleared, so a finished generation's bootstrap token can never be exchanged again. */
	ownerGeneration?: number;
	/** The protocol version the owner last reported. */
	ownerProtocolVersion?: number;
	/** When the owner exchanged its bootstrap token, at second precision; the lifetime drain counts from it. */
	ownerStartedAt?: Date;
	/** When the owner first reported idle since it last served; absent while it is busy. */
	idleSinceAt?: Date;
	/** When the control plane approved the owner's stop request; no dispatch is offered afterwards. */
	ownerStopApprovedAt?: Date;
	/** The dispatch last offered to the owner. It is never cleared when the turn claims it; its state is derived from the turn. */
	dispatchId?: string;
	dispatchTurnId?: string;
	dispatchActionId?: string;
	dispatchAttempt?: number;
	dispatchLeaseExpiresAt?: Date;
	/** Until when the owner polls at the interactive pace: set by a Files panel ping or a queued file request. Removed with the owner fields. */
	interactiveUntilAt?: Date;
	/** The id of the last queued file request; an idle stop approval is conditional on it being unchanged. Removed with the owner fields. */
	fileOperationId?: string;
}

/** The attribute names of the owner fields, removed together when an owner ends. `owner_generation` is not among them. */
export const OWNER_ATTRIBUTE_NAMES = [
	"owner_id",
	"owner_protocol_version",
	"owner_started_at",
	"idle_since_at",
	"owner_stop_approved_at",
	"dispatch_id",
	"dispatch_turn_id",
	"dispatch_action_id",
	"dispatch_attempt",
	"dispatch_lease_expires_at",
	"interactive_until_at",
	"file_operation_id",
] as const;

/**
 * The computer without its owner fields, keeping the last owner generation.
 *
 * @param computer The computer.
 * @returns The computer an ended owner leaves behind.
 */
export function withoutOwner(computer: Computer): Computer {
	const {
		ownerId: _ownerId,
		ownerProtocolVersion: _protocolVersion,
		ownerStartedAt: _startedAt,
		idleSinceAt: _idleSinceAt,
		ownerStopApprovedAt: _stopApprovedAt,
		dispatchId: _dispatchId,
		dispatchTurnId: _dispatchTurnId,
		dispatchActionId: _dispatchActionId,
		dispatchAttempt: _dispatchAttempt,
		dispatchLeaseExpiresAt: _dispatchLease,
		interactiveUntilAt: _interactiveUntil,
		fileOperationId: _fileOperationId,
		...kept
	} = computer;
	return kept;
}

const epochSeconds = (moment: Date): { N: string } => ({ N: String(Math.floor(moment.getTime() / 1000)) });
const dateFromSeconds = (attribute: AttributeValue | undefined): Date | undefined => (attribute?.N === undefined ? undefined : new Date(Number(attribute.N) * 1000));
const optionalDate = <Key extends string>(key: Key, value: Date | undefined): { [Name in Key]?: Date } =>
	value === undefined ? {} : ({ [key]: value } as { [Name in Key]?: Date });

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

	if (value.browserUnavailable === true) {
		item.browser_unavailable = { BOOL: true };
	}
	if (value.snapshotUri !== undefined) {
		item.snapshot_uri = { S: value.snapshotUri };
	}
	if (value.snapshotChecksum !== undefined) {
		item.snapshot_checksum = { S: value.snapshotChecksum };
	}
	if (value.intendedHostWorkerId !== undefined) {
		item.intended_host_worker_id = { S: value.intendedHostWorkerId };
	}
	if (value.liveWriterHostId !== undefined) {
		item.live_writer_host_id = { S: value.liveWriterHostId };
	}
	if (value.hostLostAt !== undefined) {
		item.host_lost_at = { N: String(Math.floor(value.hostLostAt.getTime() / 1000)) };
	}
	if (value.hostLostGeneration !== undefined) {
		item.host_lost_generation = { N: String(value.hostLostGeneration) };
	}
	if (value.ownerId !== undefined) item.owner_id = { S: value.ownerId };
	if (value.ownerGeneration !== undefined) item.owner_generation = { N: String(value.ownerGeneration) };
	if (value.ownerProtocolVersion !== undefined) item.owner_protocol_version = { N: String(value.ownerProtocolVersion) };
	if (value.ownerStartedAt !== undefined) item.owner_started_at = epochSeconds(value.ownerStartedAt);
	if (value.idleSinceAt !== undefined) item.idle_since_at = epochSeconds(value.idleSinceAt);
	if (value.ownerStopApprovedAt !== undefined) item.owner_stop_approved_at = epochSeconds(value.ownerStopApprovedAt);
	if (value.dispatchId !== undefined) item.dispatch_id = { S: value.dispatchId };
	if (value.dispatchTurnId !== undefined) item.dispatch_turn_id = { S: value.dispatchTurnId };
	if (value.dispatchActionId !== undefined) item.dispatch_action_id = { S: value.dispatchActionId };
	if (value.dispatchAttempt !== undefined) item.dispatch_attempt = { N: String(value.dispatchAttempt) };
	if (value.dispatchLeaseExpiresAt !== undefined) item.dispatch_lease_expires_at = epochSeconds(value.dispatchLeaseExpiresAt);
	if (value.interactiveUntilAt !== undefined) item.interactive_until_at = epochSeconds(value.interactiveUntilAt);
	if (value.fileOperationId !== undefined) item.file_operation_id = { S: value.fileOperationId };

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
		...(item.browser_unavailable?.BOOL === true ? { browserUnavailable: true } : {}),
		hostStartGeneration,
		hostStartDispatchedGeneration,
		snapshotGeneration,
		diskDirty,
		hydrateRequired,
		hostStartLeaseExpiresAt: leaseEpoch ? new Date(leaseEpoch * 1000) : undefined,
		snapshotUri: item.snapshot_uri?.S,
		snapshotChecksum: item.snapshot_checksum?.S,
		intendedHostWorkerId: item.intended_host_worker_id?.S,
		liveWriterHostId: item.live_writer_host_id?.S,
		hostLostAt: item.host_lost_at?.N ? new Date(Number(item.host_lost_at.N) * 1000) : undefined,
		hostLostGeneration: item.host_lost_generation?.N ? Number(item.host_lost_generation.N) : undefined,
		...(item.owner_id?.S === undefined ? {} : { ownerId: item.owner_id.S }),
		...(item.owner_generation?.N === undefined ? {} : { ownerGeneration: Number(item.owner_generation.N) }),
		...(item.owner_protocol_version?.N === undefined ? {} : { ownerProtocolVersion: Number(item.owner_protocol_version.N) }),
		...optionalDate("ownerStartedAt", dateFromSeconds(item.owner_started_at)),
		...optionalDate("idleSinceAt", dateFromSeconds(item.idle_since_at)),
		...optionalDate("ownerStopApprovedAt", dateFromSeconds(item.owner_stop_approved_at)),
		...(item.dispatch_id?.S === undefined ? {} : { dispatchId: item.dispatch_id.S }),
		...(item.dispatch_turn_id?.S === undefined ? {} : { dispatchTurnId: item.dispatch_turn_id.S }),
		...(item.dispatch_action_id?.S === undefined ? {} : { dispatchActionId: item.dispatch_action_id.S }),
		...(item.dispatch_attempt?.N === undefined ? {} : { dispatchAttempt: Number(item.dispatch_attempt.N) }),
		...optionalDate("dispatchLeaseExpiresAt", dateFromSeconds(item.dispatch_lease_expires_at)),
		...optionalDate("interactiveUntilAt", dateFromSeconds(item.interactive_until_at)),
		...(item.file_operation_id?.S === undefined ? {} : { fileOperationId: item.file_operation_id.S }),
	};
}
