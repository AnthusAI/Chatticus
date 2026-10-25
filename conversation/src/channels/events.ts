/** The detail type of the event that tells the delivery handler a reply is owed. */
export const CHANNEL_MESSAGE_CREATED = "channel.message.created";

/** The detail of a channel event: ids only, never a message body or an address. */
export interface ChannelMessageCreatedDetail {
	readonly tenant_id: string;
	readonly message_id: string;
	readonly binding_id: string;
}

/** An event for the delivery handler. */
export interface ChannelEvent {
	readonly detailType: typeof CHANNEL_MESSAGE_CREATED;
	readonly detail: ChannelMessageCreatedDetail;
}

/** Publishes channel events to the bus whose rule invokes the delivery handler. */
export interface ChannelEventPublisher {
	publish(event: ChannelEvent): Promise<void>;
}

/**
 * The event for a reply owed.
 *
 * @param ids The organization, the committed reply and the binding it is owed to.
 * @returns The event; its detail holds exactly these three ids.
 */
export function channelMessageCreatedEvent(ids: { tenantId: string; messageId: string; bindingId: string }): ChannelEvent {
	return {
		detailType: CHANNEL_MESSAGE_CREATED,
		detail: { tenant_id: ids.tenantId, message_id: ids.messageId, binding_id: ids.bindingId },
	};
}
