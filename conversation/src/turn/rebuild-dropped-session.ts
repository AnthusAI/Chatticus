import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { ChannelLogDoc } from "../pi/channel-log.ts";
import { list as listMailbox } from "../pi/mailbox.ts";
import { rowsForRebuild, writeRecordMessages } from "../pi/session-rebuild.ts";
import type { OwnerSession } from "../pi/session.ts";
import type { ExecutorDeps } from "./types.ts";

/**
 * Give a session that holds no channel history the history the channel record holds. A session is empty when it was
 * dropped by an erasure, or when the bot has only just joined a channel that already has messages. The turn owner calls
 * this once it owns the session and before it takes in the mailbox, so no turn ever runs on an empty session; the messages
 * still waiting in the bot's mailbox are left for the mailbox to deliver. A session that already has history is untouched.
 *
 * @param deps The owner's dependencies.
 * @param session The owner's session.
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @param context Cancellation context.
 * @returns How many messages were written.
 */
export async function rebuildDroppedSession(
	deps: Pick<ExecutorDeps, "client" | "messaging" | "messagingTableName">,
	session: OwnerSession,
	tenantId: string,
	botId: string,
	channelId: string,
	context: Context,
): Promise<number> {
	const log = await session.harness.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID, context);
	if (log !== undefined && log.lines.length > 0) return 0;
	const record = await deps.messaging.listMessages(tenantId, channelId, 0);
	const unread = new Set(
		(await listMailbox({ client: deps.client, tableName: deps.messagingTableName }, tenantId, botId, channelId)).map((item) => item.seq),
	);
	return writeRecordMessages(session.harness, botId, rowsForRebuild(record, unread));
}
