import { createHash } from "node:crypto";
import { createChannel, createExternalChannel, uuid5InUrlNamespace, type Channel } from "../domain/channels.ts";
import type { IdSource } from "../http/app.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { correlatorTagMatchesChannel } from "./channel-correlator.ts";
import type { ChannelStore } from "./records.ts";
import type { ChannelTransport, InboundEvent } from "./transport.ts";

/** The longest channel name taken from a subject. */
const MAXIMUM_NAME_CHARACTERS = 120;

/**
 * The deterministic identifier of the external channel of one conversation of one binding, so two deliveries that race
 * to open it open the same channel.
 *
 * @param tenantId The organization.
 * @param bindingId The binding the conversation arrived on.
 * @param conversationKey The provider's own unit of conversation.
 * @returns A version 5 UUID.
 */
export function externalChannelId(tenantId: string, bindingId: string, conversationKey: string): string {
	const digest = createHash("sha256").update(JSON.stringify([tenantId, bindingId, conversationKey])).digest("hex");
	return uuid5InUrlNamespace(`chatticus:external:${digest}`);
}

/**
 * The member's own external channel with the addressed bot whose correlator tag is the hint. Only channels the member
 * already takes part in are candidates, so the hint can only ever find a thread the sender could reach anyway.
 */
async function correlatedChannelId(deps: MappingDependencies, hint: string, tenantId: string, userId: string, addressedBotId: string): Promise<string | null> {
	const candidates = await deps.messaging.listChannels(tenantId, userId);
	const match = candidates.find(
		(candidate) =>
			candidate.kind === "external" &&
			candidate.participants.some((participant) => participant.kind === "bot" && participant.actorId === addressedBotId) &&
			correlatorTagMatchesChannel(deps.correlatorSecret, tenantId, candidate.channelId, hint),
	);
	return match === undefined ? null : match.channelId;
}

/** What the mapping reads and writes. */
export interface MappingDependencies {
	readonly store: ChannelStore;
	readonly messaging: MessagingStore;
	readonly ids: IdSource;
	readonly correlatorSecret: string;
}

/**
 * Find or open the one Chatticus channel an external conversation is.
 *
 * A pair conversation (a direct message, a text) is the member's existing direct channel with the bot. A thread
 * conversation is found by its conversation key, then by any earlier message it references, and otherwise opens a new
 * external channel named from the subject, with the addressed bot, the bots that were copied and the member as
 * participants. Either way the conversation key and the message are indexed so a later message finds the channel.
 *
 * @param deps The stores and identifiers.
 * @param transport The transport the event arrived on; its granularity decides the shape.
 * @param event The inbound event.
 * @param binding The binding the event was routed to.
 * @param member The member the sender is linked to.
 * @param botIds The addressed bot first, then the bots that read.
 * @returns The channel, or null when the conversation is indexed to another channel or the channel has no place for the addressed bot.
 */
export async function mapExternalConversation(
	deps: MappingDependencies,
	transport: ChannelTransport,
	event: InboundEvent,
	binding: { tenantId: string; bindingId: string },
	member: { userId: string },
	botIds: readonly string[],
): Promise<Channel | null> {
	const { tenantId, bindingId } = binding;
	const addressedBotId = botIds[0]!;
	if (transport.capabilities.conversationGranularity === "pair") {
		const direct = await createChannel(tenantId, member.userId, [addressedBotId], { kind: "direct" }, { store: deps.messaging, ids: deps.ids });
		await deps.store.putConversationChannelIfAbsent(tenantId, bindingId, event.conversationKey, direct.channelId);
		return direct;
	}
	let channelId = await deps.store.getConversationChannel(tenantId, bindingId, event.conversationKey);
	if (channelId === null) {
		for (const referenced of event.referencedExternalMessageIds) {
			channelId = await deps.store.getMessageChannel(tenantId, bindingId, referenced);
			if (channelId !== null) break;
		}
	}
	if (channelId === null && event.correlatorHint !== null) {
		channelId = await correlatedChannelId(deps, event.correlatorHint, tenantId, member.userId, addressedBotId);
	}
	let channel: Channel | null = channelId === null ? null : await deps.messaging.getChannel(tenantId, channelId);
	if (channel === null) {
		const name = event.subject === null ? null : event.subject.slice(0, MAXIMUM_NAME_CHARACTERS);
		const deterministicId = externalChannelId(tenantId, bindingId, event.conversationKey);
		const existing = await deps.messaging.getChannel(tenantId, deterministicId);
		if (existing !== null) {
			channel = existing;
		} else {
			const created = await createExternalChannel(
				tenantId,
				{ memberUserId: member.userId, botIds: [...botIds], name },
				{ store: deps.messaging, ids: { next: () => deterministicId } },
			);
			channel = await deps.messaging.putChannelIfAbsent(created);
		}
	}
	const indexed = await deps.store.putConversationChannelIfAbsent(tenantId, bindingId, event.conversationKey, channel.channelId);
	if (indexed !== channel.channelId) return null;
	if (!channel.participants.some((participant) => participant.kind === "bot" && participant.actorId === addressedBotId)) return null;
	return channel;
}
