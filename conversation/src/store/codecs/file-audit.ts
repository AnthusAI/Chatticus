/**
 * Codec for the file audit record: who did what to which path, written by the Front Door before it asks the owner, and
 * finished when the owner answers. It holds hashes, sizes and names, never file content. See docs/LIVE_FILES_PROTOCOL.md
 * section 7.1.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { fileAuditKey } from "../keys.ts";

/** What was done. */
export type FileAuditOperation = "write" | "create" | "reveal" | "discard" | "overlay_apply" | "delete" | "move" | "mkdir";

/** Where it was done. */
export type FileAuditSource = "live" | "snapshot" | "overlay";

/** How it ended; `pending` is written first and read as `unknown` after 120 seconds. */
export type FileAuditOutcome = "pending" | "ok" | "conflict" | "refused" | "failed" | "unknown";

/** One audit record. */
export interface FileAuditRecord {
	tenantId: string;
	computerId: string;
	/** From the principal, never from a body. */
	userId: string;
	operationId: string;
	operation: FileAuditOperation;
	path: string;
	source: FileAuditSource;
	outcome: FileAuditOutcome;
	at: Date;
	expiresAt: Date;
	toPath?: string;
	recursive?: boolean;
	removed?: number;
	treeSha256Before?: string;
	resolvedPath?: string;
	ownerId?: string;
	errorCode?: string;
	/** The hash the person expected. */
	sha256Before?: string;
	sha256BeforeReported?: string;
	/** Computed by the Front Door from the bytes it sent. */
	sha256After?: string;
	sha256AfterReported?: string;
	bytes?: number;
	secretName?: boolean;
	revealed?: boolean;
	keptAs?: string;
	flags?: string[];
	finishedAt?: Date;
}

export type Item = Record<string, AttributeValue>;

const epochSeconds = (moment: Date): { N: string } => ({ N: String(Math.floor(moment.getTime() / 1000)) });

/**
 * Encode an audit record to a DynamoDB item.
 * @param value The record.
 * @returns The DynamoDB item.
 */
export function encode(value: FileAuditRecord): Item {
	const key = fileAuditKey(value.tenantId, value.at.getTime(), value.operationId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: value.tenantId },
		computer_id: { S: value.computerId },
		user_id: { S: value.userId },
		operation_id: { S: value.operationId },
		operation: { S: value.operation },
		path: { S: value.path },
		source: { S: value.source },
		outcome: { S: value.outcome },
		at: { S: value.at.toISOString() },
		expires_at: epochSeconds(value.expiresAt),
	};
	const strings: [string, string | undefined][] = [
		["to_path", value.toPath],
		["tree_sha256_before", value.treeSha256Before],
		["resolved_path", value.resolvedPath],
		["owner_id", value.ownerId],
		["error_code", value.errorCode],
		["sha256_before", value.sha256Before],
		["sha256_before_reported", value.sha256BeforeReported],
		["sha256_after", value.sha256After],
		["sha256_after_reported", value.sha256AfterReported],
		["kept_as", value.keptAs],
	];
	for (const [name, text] of strings) if (text !== undefined) item[name] = { S: text };
	if (value.recursive !== undefined) item.recursive = { BOOL: value.recursive };
	if (value.removed !== undefined) item.removed = { N: String(value.removed) };
	if (value.bytes !== undefined) item.bytes = { N: String(value.bytes) };
	if (value.secretName !== undefined) item.secret_name = { BOOL: value.secretName };
	if (value.revealed !== undefined) item.revealed = { BOOL: value.revealed };
	if (value.flags !== undefined && value.flags.length > 0) item.flags = { SS: [...value.flags] };
	if (value.finishedAt !== undefined) item.finished_at = { S: value.finishedAt.toISOString() };
	return item;
}

function required(item: Item, name: string): string {
	const value = item[name]?.S;
	if (value === undefined || value === "") throw new Error(`malformed file audit item: ${name}`);
	return value;
}

/**
 * Decode an audit record from a DynamoDB item.
 * @param item The DynamoDB item.
 * @returns The record.
 * @throws Error When a required attribute is missing.
 */
export function decode(item: Item): FileAuditRecord {
	const expiresAt = item.expires_at?.N;
	if (expiresAt === undefined) throw new Error("malformed file audit item: expires_at");
	return {
		tenantId: required(item, "tenant_id"),
		computerId: required(item, "computer_id"),
		userId: required(item, "user_id"),
		operationId: required(item, "operation_id"),
		operation: required(item, "operation") as FileAuditOperation,
		path: required(item, "path"),
		source: required(item, "source") as FileAuditSource,
		outcome: required(item, "outcome") as FileAuditOutcome,
		at: new Date(required(item, "at")),
		expiresAt: new Date(Number(expiresAt) * 1000),
		...(item.to_path?.S === undefined ? {} : { toPath: item.to_path.S }),
		...(item.recursive?.BOOL === undefined ? {} : { recursive: item.recursive.BOOL }),
		...(item.removed?.N === undefined ? {} : { removed: Number(item.removed.N) }),
		...(item.tree_sha256_before?.S === undefined ? {} : { treeSha256Before: item.tree_sha256_before.S }),
		...(item.resolved_path?.S === undefined ? {} : { resolvedPath: item.resolved_path.S }),
		...(item.owner_id?.S === undefined ? {} : { ownerId: item.owner_id.S }),
		...(item.error_code?.S === undefined ? {} : { errorCode: item.error_code.S }),
		...(item.sha256_before?.S === undefined ? {} : { sha256Before: item.sha256_before.S }),
		...(item.sha256_before_reported?.S === undefined ? {} : { sha256BeforeReported: item.sha256_before_reported.S }),
		...(item.sha256_after?.S === undefined ? {} : { sha256After: item.sha256_after.S }),
		...(item.sha256_after_reported?.S === undefined ? {} : { sha256AfterReported: item.sha256_after_reported.S }),
		...(item.bytes?.N === undefined ? {} : { bytes: Number(item.bytes.N) }),
		...(item.secret_name?.BOOL === undefined ? {} : { secretName: item.secret_name.BOOL }),
		...(item.revealed?.BOOL === undefined ? {} : { revealed: item.revealed.BOOL }),
		...(item.kept_as?.S === undefined ? {} : { keptAs: item.kept_as.S }),
		...(item.flags?.SS === undefined ? {} : { flags: [...item.flags.SS].sort() }),
		...(item.finished_at?.S === undefined ? {} : { finishedAt: new Date(item.finished_at.S) }),
	};
}
