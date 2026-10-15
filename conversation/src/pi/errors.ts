import { CommitOutcomeUnknown, OwnershipLost } from "../storage/storage-support.ts";

export { CommitOutcomeUnknown, OwnershipLost };

/**
 * Whether an error means the executor must stop at once and reconcile: the storage could not tell whether the last
 * commit landed. `OwnershipLost` alone is not fatal in this sense; the executor just closes and returns.
 *
 * @param error Any thrown value.
 * @returns True for `CommitOutcomeUnknown`.
 */
export const isFatalCommitUncertain = (error: unknown): boolean => error instanceof CommitOutcomeUnknown;

const MAXIMUM_CAUSE_DEPTH = 8;

/**
 * Find the storage failure behind an error. Pi poisons a session whose commit failed after storage admission and then
 * rejects every later call with a plain error whose `cause` is the original failure, so the failure that matters may sit
 * a few causes down.
 *
 * @param error Any thrown value.
 * @returns The first `CommitOutcomeUnknown` or `OwnershipLost` in the cause chain, or null when there is none.
 */
export function findStorageFailure(error: unknown): OwnershipLost | null {
	let current: unknown = error;
	for (let depth = 0; depth < MAXIMUM_CAUSE_DEPTH && current instanceof Error; depth += 1) {
		if (current instanceof OwnershipLost) return current;
		current = current.cause;
	}
	return null;
}
