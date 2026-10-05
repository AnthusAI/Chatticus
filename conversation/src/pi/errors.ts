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
