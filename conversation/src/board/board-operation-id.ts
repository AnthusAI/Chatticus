import { createHash } from "node:crypto";

const UUID_VERSION_FIVE_MASK = 0x50;
const UUID_VARIANT_MASK = 0x80;

/**
 * A UUID derived deterministically from its parts, so the same board, action, step and caller key always name the same
 * Kanbus operation and a retry replays the first result instead of repeating the write. The Kanbus service requires the
 * `X-Operation-Id` header to hold a UUID.
 *
 * The request body is deliberately not an input: the same id with a different body must reach Kanbus unchanged so that
 * Kanbus refuses it with `operation_conflict`.
 *
 * @param parts The values that identify one intended change, in a fixed order.
 * @returns A lowercase UUID in the 8-4-4-4-12 form.
 */
export function deriveBoardOperationId(parts: readonly string[]): string {
	const digest = createHash("sha256").update(parts.join("\u0000")).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6]! & 0x0f) | UUID_VERSION_FIVE_MASK;
	bytes[8] = (bytes[8]! & 0x3f) | UUID_VARIANT_MASK;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
