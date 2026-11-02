import type { MessagingStore } from "../store/messaging-store.ts";
import type { CommittedMessage } from "./transport.ts";

/**
 * The committed message at one sequence of a channel, read from the channel record.
 *
 * @param deps The messaging store.
 * @param tenantId The organization.
 * @param channelId The channel.
 * @param seq The sequence of the message.
 * @returns The message, or null when the channel or the message does not exist, or the message was deleted.
 */
export async function loadCommittedMessage(
	deps: { readonly messaging: Pick<MessagingStore, "listMessages"> },
	tenantId: string,
	channelId: string,
	seq: number,
): Promise<CommittedMessage | null> {
	const found = (await deps.messaging.listMessages(tenantId, channelId, seq - 1)).find((entry) => entry.seq === seq);
	return found === undefined || found.deletedAt !== undefined
		? null
		: { messageId: found.messageId, channelId: found.channelId, tenantId: found.tenantId, seq: found.seq, body: found.body, createdAt: found.createdAt };
}
