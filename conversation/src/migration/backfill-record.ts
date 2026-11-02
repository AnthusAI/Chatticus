import type { ActorKind, Channel, ChannelMessageRecord } from "../domain/channels.ts";
import { type ListedMessage, listChannelMessages } from "../pi/channel-listing.ts";
import { MessageBodyTooLargeError } from "../store/codecs/channel.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { MigrationDependencies } from "./copy.ts";

/** What the channel record backfill needs: the migration clients and the messaging store that holds the record. */
export type BackfillDependencies = MigrationDependencies & { readonly store: MessagingStore };

/** What one channel's backfill found and wrote. */
export type ChannelBackfillReport = {
	tenantId: string;
	channelId: string;
	/** Messages the sessions and mailboxes held, which is every message the channel ever committed. */
	held: number;
	/** Messages the record already held, such as the old `msg#` items or messages written since the record began. */
	alreadyRecorded: number;
	/** Messages this pass wrote; zero in a dry run. */
	written: number;
	/** Sequences whose body was too large for a record row; they are not written and need the S3 overflow path. */
	tooLarge: number[];
	dryRun: boolean;
};

const recordOf = (listed: ListedMessage): ChannelMessageRecord => ({
	messageId: listed.message_id,
	channelId: listed.channel_id,
	tenantId: listed.tenant_id,
	seq: listed.seq,
	authorKind: listed.author_kind as ActorKind,
	authorId: listed.author_id,
	body: listed.body,
	addressedToBotId: listed.addressed_to_bot_id,
	createdAt: new Date(listed.created_at),
	...(listed.origin === undefined ? {} : { origin: listed.origin }),
	...(listed.activity === undefined ? {} : { activity: listed.activity }),
});

/**
 * Fill a channel's record from what its bot sessions and mailboxes hold: the same merge the message list used before the
 * record existed, run once. Idempotent and resumable: a sequence the record already holds is left alone, so a second pass
 * after the new code is deployed writes only what the old code committed in between. A channel with no bot has nothing
 * to merge and nothing to write.
 *
 * @param deps Clients, tables and the messaging store.
 * @param channel The channel.
 * @param options Whether to only report.
 * @returns What the channel held and what was written.
 */
export async function backfillChannelRecord(
	deps: BackfillDependencies,
	channel: Channel,
	options: { dryRun: boolean },
): Promise<ChannelBackfillReport> {
	const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	const held = await listChannelMessages(deps, channel.tenantId, channel.channelId, botIds, 0);
	const recorded = new Set((await deps.store.listMessages(channel.tenantId, channel.channelId, 0)).map((message) => message.seq));
	const report: ChannelBackfillReport = {
		tenantId: channel.tenantId,
		channelId: channel.channelId,
		held: held.length,
		alreadyRecorded: held.filter((message) => recorded.has(message.seq)).length,
		written: 0,
		tooLarge: [],
		dryRun: options.dryRun,
	};
	for (const message of held) {
		if (recorded.has(message.seq)) continue;
		if (options.dryRun) continue;
		try {
			await deps.store.putMessage(recordOf(message));
			report.written += 1;
		} catch (error) {
			if (!(error instanceof MessageBodyTooLargeError)) throw error;
			report.tooLarge.push(message.seq);
		}
	}
	return report;
}
