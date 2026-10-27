import type { DeliveryFailureClass, TransportProvider } from "./transport.ts";

/** One owner-managed attachment of an external endpoint to a bot of one organization. */
export interface ChannelBinding {
	readonly tenantId: string;
	readonly bindingId: string;
	readonly provider: TransportProvider;
	readonly routeKey: string;
	readonly botId: string;
	readonly enabled: boolean;
	readonly limits: Readonly<Record<string, number>>;
	readonly createdBy: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** What an organization has chosen and been granted for external channels. */
export interface ChannelSettings {
	readonly tenantId: string;
	readonly externalChannelsEnabled: boolean;
	readonly mailHandle: string | null;
}

/** The organization and binding a route key belongs to. */
export interface RouteTarget {
	readonly tenantId: string;
	readonly bindingId: string;
}

/** A proven link from an external identity to a member of the organization. */
export interface ExternalIdentityLink {
	readonly tenantId: string;
	readonly provider: TransportProvider;
	readonly externalId: string;
	readonly userId: string;
	readonly linkedBy: string;
	readonly linkedAt: Date;
}

/** What the store knows about one inbound external message after a claim. */
export interface InboundMessageRecord {
	readonly status: "claimed" | "done";
	readonly claimedAt: Date;
	readonly channelId: string | null;
	readonly messageId: string | null;
	readonly turnId: string | null;
}

/** The result of trying to claim an inbound external message. */
export type InboundClaim =
	| { readonly kind: "claimed" }
	| { readonly kind: "done"; readonly record: InboundMessageRecord }
	| { readonly kind: "in_flight" };

/** Where one reply stands. */
export type DeliveryState = "pending" | "retryable" | "sent" | "failed" | "delivered" | "bounced" | "complained";

/** One reply owed to an external transport. It holds ids and the reply target, never a message body. */
export interface DeliveryRecord {
	readonly tenantId: string;
	readonly messageId: string;
	readonly bindingId: string;
	readonly channelId: string;
	readonly messageSeq: number;
	readonly conversationKey: string;
	readonly recipientExternalId: string;
	readonly inReplyToExternalMessageId: string;
	readonly state: DeliveryState;
	readonly attempts: number;
	readonly failureClass: DeliveryFailureClass | null;
	readonly reasonCode: string | null;
	readonly providerMessageId: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** Everything the channel features store, behind one seam. */
export interface ChannelStore {
	getSettings(tenantId: string): Promise<ChannelSettings>;
	setExternalChannelsEnabled(tenantId: string, enabled: boolean): Promise<void>;
	/** Claim the handle for the organization, releasing the one it held; false when another organization holds it. */
	claimMailHandle(tenantId: string, handle: string): Promise<boolean>;

	/** Store the binding and its route together; false when the route key is already claimed. */
	createBinding(binding: ChannelBinding): Promise<boolean>;
	getBinding(tenantId: string, bindingId: string): Promise<ChannelBinding | null>;
	listBindings(tenantId: string): Promise<ChannelBinding[]>;
	/** Turn a binding on or off, keeping everything else; null when there is no such binding. */
	setBindingEnabled(tenantId: string, bindingId: string, enabled: boolean, at: Date): Promise<ChannelBinding | null>;
	resolveRoute(provider: TransportProvider, routeKey: string): Promise<RouteTarget | null>;

	getIdentityLink(tenantId: string, provider: TransportProvider, externalId: string): Promise<ExternalIdentityLink | null>;
	putIdentityLink(link: ExternalIdentityLink): Promise<void>;

	getConversationChannel(tenantId: string, bindingId: string, conversationKey: string): Promise<string | null>;
	/** Record the channel of a conversation unless one is recorded; returns the channel id that now stands. */
	putConversationChannelIfAbsent(tenantId: string, bindingId: string, conversationKey: string, channelId: string): Promise<string>;
	getMessageChannel(tenantId: string, bindingId: string, externalMessageId: string): Promise<string | null>;
	putMessageChannel(tenantId: string, bindingId: string, externalMessageId: string, channelId: string): Promise<void>;

	/** Claim an inbound message for processing; a claim older than the lease is taken over. */
	claimInbound(tenantId: string, bindingId: string, externalMessageId: string, now: Date, leaseSeconds: number): Promise<InboundClaim>;
	completeInbound(tenantId: string, bindingId: string, externalMessageId: string, result: { channelId: string; messageId: string; turnId: string | null }): Promise<void>;

	/** Record a reply owed, once: false when the delivery already exists. */
	putDeliveryIfAbsent(delivery: DeliveryRecord): Promise<boolean>;
	getDelivery(tenantId: string, messageId: string, bindingId: string): Promise<DeliveryRecord | null>;
	/** Replace a delivery; one that is no longer open leaves the open list. */
	putDelivery(delivery: DeliveryRecord): Promise<void>;
	/** Deliveries still owed (pending or retryable), oldest first. */
	listOpenDeliveries(tenantId: string): Promise<DeliveryRecord[]>;
	listDeliveries(tenantId: string, bindingId: string): Promise<DeliveryRecord[]>;
	/** Remember which delivery a provider message id belongs to, so a provider callback that names only that id finds it. */
	putProviderMessageIndex(provider: TransportProvider, providerMessageId: string, target: { tenantId: string; messageId: string; bindingId: string }): Promise<void>;
	getDeliveryByProviderMessage(provider: TransportProvider, providerMessageId: string): Promise<DeliveryRecord | null>;
}
