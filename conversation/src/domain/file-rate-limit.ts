import {
	LIVE_FILE_RATE_WINDOW_SECONDS,
	LIVE_FILE_READ_RATE,
	LIVE_FILE_REVEAL_RATE,
	LIVE_FILE_WATCH_RATE,
	LIVE_FILE_WRITE_RATE,
} from "@chatticus/host-protocol/live-files";
import type { MessagingStore } from "../store/messaging-store.ts";
import { MemberFileRefusal } from "./member-file-refusal.ts";

/** The kinds of file request a member is counted for. Delete, rename and new folder count as writes. */
export type FileRateClass = "read" | "write" | "reveal" | "watch";

const LIMIT_OF: Readonly<Record<FileRateClass, number>> = {
	read: LIVE_FILE_READ_RATE,
	write: LIVE_FILE_WRITE_RATE,
	reveal: LIVE_FILE_REVEAL_RATE,
	watch: LIVE_FILE_WATCH_RATE,
};

/** Seconds left in the fixed window that contains `now`; at least one. */
export function secondsLeftInWindow(now: Date, windowSeconds: number = LIVE_FILE_RATE_WINDOW_SECONDS): number {
	return windowSeconds - (Math.floor(now.getTime() / 1000) % windowSeconds);
}

/**
 * Count one request of a class for a member and refuse it past the limit of the class in the current minute. The counters
 * are items in the table, so the limit holds across Front Door instances. A refused request is counted too.
 *
 * @param store The store the counters live in.
 * @param userId The member, or the tenant partition key of a caller that is not a user.
 * @param rateClass Which limit.
 * @param now The current time.
 * @throws MemberFileRefusal `rate_limited`, carrying the seconds until the window ends.
 */
export async function countFileRequest(store: Pick<MessagingStore, "incrementRateCounter">, userId: string, rateClass: FileRateClass, now: Date): Promise<void> {
	const count = await store.incrementRateCounter(userId, `file_rate#${rateClass}`, now, LIVE_FILE_RATE_WINDOW_SECONDS);
	if (count > LIMIT_OF[rateClass]) {
		throw new MemberFileRefusal("rate_limited", `Too many ${rateClass} requests; try again in a moment.`, { retryAfterSeconds: secondsLeftInWindow(now) });
	}
}
