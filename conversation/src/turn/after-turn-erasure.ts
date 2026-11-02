import { hasPendingErasure } from "../domain/message-erasure.ts";
import type { ExecutorDeps } from "./types.ts";

/**
 * When a turn ends, ask for the erasures that were waiting on it to be finished. If the channel has a pending erasure, a
 * message goes to the erasure queue; the erasure function drops the sessions that are idle now and tombstones any answer
 * the turn committed. Nothing happens where the owner has no erasure queue (a computer owner), because the erasure
 * function also sweeps every pending erasure once a minute. A failure here never fails the turn.
 *
 * @param deps The owner's dependencies.
 * @param tenantId Organization.
 * @param channelId Channel.
 */
export async function requestPendingErasureCompletion(
	deps: Pick<ExecutorDeps, "client" | "messagingTableName" | "erasureQueue">,
	tenantId: string,
	channelId: string,
): Promise<void> {
	if (deps.erasureQueue === undefined) return;
	try {
		if (await hasPendingErasure({ client: deps.client, tableName: deps.messagingTableName }, tenantId, channelId)) {
			await deps.erasureQueue.send({ type: "complete", tenantId, channelId });
		}
	} catch (error) {
		console.info(`erasure_completion_request_failed tenant_id=${tenantId} channel_id=${channelId} detail=${error instanceof Error ? error.message : String(error)}`);
	}
}
