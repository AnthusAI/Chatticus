import { listChannelMessages } from "../pi/channel-listing.ts";
import type { ChannelListingDependencies } from "../pi/channel-listing.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { CommittedMessage } from "./transport.ts";

/**
 * The committed message at one sequence of a channel, read from the bot sessions' logs and mailboxes the way the channel's
 * message list reads them.
 *
 * @param deps The messaging store and the listing dependencies.
 * @param tenantId The organization.
 * @param channelId The channel.
 * @param seq The sequence of the message.
 * @returns The message, or null when the channel or the message does not exist.
 */
export async function loadCommittedMessage(
	deps: { readonly messaging: Pick<MessagingStore, "getChannel">; readonly listing: ChannelListingDependencies },
	tenantId: string,
	channelId: string,
	seq: number,
): Promise<CommittedMessage | null> {
	const channel = await deps.messaging.getChannel(tenantId, channelId);
	if (channel === null) return null;
	const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	const listed = await listChannelMessages(deps.listing, channel.tenantId, channel.channelId, botIds, seq - 1);
	const found = listed.find((entry) => entry.seq === seq);
	return found === undefined
		? null
		: { messageId: found.message_id, channelId: found.channel_id, tenantId: found.tenant_id, seq: found.seq, body: found.body, createdAt: new Date(found.created_at) };
}
