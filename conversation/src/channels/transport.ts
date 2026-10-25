import type { MessageOriginAssertion } from "../domain/channels.ts";

/** Every provider that can sit behind the channel transport port. */
export type TransportProvider = "email" | "sms" | "slack" | "teams" | "discord" | "fake";

/** What a provider can carry and how it proves who sent a message. */
export interface TransportCapabilities {
	readonly maxBodyCharacters: number;
	readonly conversationGranularity: "thread" | "pair";
	readonly supportsAttachments: boolean;
	readonly supportsRichText: "none" | "basic_html" | "provider_blocks";
	readonly reportsDelivery: boolean;
	readonly requiresRecipientOptIn: boolean;
	readonly authenticatesSender: "per_message" | "per_request_signature" | "none";
}

/** An unverified request exactly as the provider's endpoint received it. */
export interface RawInbound {
	readonly provider: TransportProvider;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly receivedAt: Date;
}

/** A request whose signature and authentication verdicts passed; the payload is still provider specific. */
export interface VerifiedInbound {
	readonly kind: "verified";
	readonly provider: TransportProvider;
	readonly payload: unknown;
	readonly receivedAt: Date;
	readonly rawReference: string | null;
}

/** A request the transport refused before parsing it into events. */
export interface InboundRefusal {
	readonly kind: "refused";
	readonly reason: string;
}

/** An attachment already stored, referenced by its storage key. */
export interface AttachmentReference {
	readonly storageKey: string;
	readonly fileName: string;
	readonly contentType: string;
	readonly sizeBytes: number;
}

/** The booleans a transport derives from provider headers; the automation filter reads them. */
export interface AutomationHints {
	readonly autoSubmitted: boolean;
	readonly bulkPrecedence: boolean;
	readonly bounceReport: boolean;
	readonly listMail: boolean;
	readonly ownOrigin: boolean;
}

/** Who sent a message and how the provider proved it. */
export interface InboundSender {
	readonly externalId: string;
	readonly displayName: string | null;
	readonly assertion: MessageOriginAssertion;
}

/** The other bot endpoints a message was addressed to; they read the conversation and do not act. */
export interface InboundAddressing {
	readonly to: readonly string[];
	readonly cc: readonly string[];
}

/** One provider-neutral inbound message. Every transport produces these and the core admits them through one path. */
export interface InboundEvent {
	readonly provider: TransportProvider;
	readonly bindingRouteKey: string;
	readonly externalMessageId: string;
	readonly conversationKey: string;
	readonly referencedExternalMessageIds: readonly string[];
	readonly subject: string | null;
	readonly sender: InboundSender;
	readonly text: string;
	readonly attachments: readonly AttachmentReference[];
	readonly addressing: InboundAddressing;
	readonly automationHints: AutomationHints;
	readonly receivedAt: Date;
	readonly rawReference: string | null;
}

/** The committed message a transport renders; the body is the plain text the bot wrote. */
export interface CommittedMessage {
	readonly messageId: string;
	readonly channelId: string;
	readonly tenantId: string;
	readonly seq: number;
	readonly body: string;
	readonly createdAt: Date;
}

/** Where a reply goes in the provider's own conversation. */
export interface ThreadContext {
	readonly conversationKey: string;
	readonly recipientExternalId: string;
	readonly inReplyToExternalMessageId: string;
	readonly subject: string | null;
}

/** A provider payload ready to send. */
export interface OutboundPayload {
	readonly provider: TransportProvider;
	readonly recipientExternalId: string;
	readonly conversationKey: string;
	readonly inReplyToExternalMessageId: string;
	readonly subject: string | null;
	readonly text: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** What the provider answered for a send; the external message id is the one a later reply will reference. */
export interface DeliveryReceipt {
	readonly providerMessageId: string;
	readonly externalMessageId: string;
}

/** How a failed send is classified. */
export type DeliveryFailureClass = "retryable" | "permanent" | "suppressed" | "opted_out";

/** What a provider callback reports about a message already sent. */
export type DeliveryStatus = "delivered" | "bounced" | "complained" | "opted_out";

/** One provider callback about one sent message. */
export interface DeliveryStatusEvent {
	readonly provider: TransportProvider;
	readonly providerMessageId: string;
	readonly status: DeliveryStatus;
	readonly reason: string | null;
}

/** The error a transport throws from `deliver`, carrying the classification the delivery record keeps. */
export class TransportDeliveryError extends Error {
	readonly failureClass: DeliveryFailureClass;
	readonly reasonCode: string;

	/**
	 * @param failureClass How the delivery record classifies the failure.
	 * @param reasonCode A short machine-readable reason an owner can read.
	 */
	constructor(failureClass: DeliveryFailureClass, reasonCode: string) {
		super(`delivery failed (${failureClass}): ${reasonCode}`);
		this.name = "TransportDeliveryError";
		this.failureClass = failureClass;
		this.reasonCode = reasonCode;
	}
}

/** The binding facts a transport needs to render and send. */
export interface TransportBinding {
	readonly bindingId: string;
	readonly tenantId: string;
	readonly provider: TransportProvider;
	readonly routeKey: string;
}

/**
 * The port every provider adapter implements. Adapters own bytes: verify, parse, render, send. The core owns identity,
 * authorization, deduplication, limits, conversation mapping and delivery state.
 */
export interface ChannelTransport {
	readonly provider: TransportProvider;
	readonly capabilities: TransportCapabilities;

	/** Check signatures and authentication verdicts; no side effects. */
	verifyInbound(raw: RawInbound): Promise<VerifiedInbound | InboundRefusal>;

	/** Turn one verified envelope into provider-neutral events; pure. */
	normalize(verified: VerifiedInbound): InboundEvent[];

	/** Turn a committed message into the provider payload, applying the provider's length, formatting and threading rules; pure. */
	render(message: CommittedMessage, binding: TransportBinding, thread: ThreadContext): OutboundPayload;

	/** The only outbound side effect. Idempotent by `idempotencyKey`: a repeat produces no second provider send. */
	deliver(payload: OutboundPayload, binding: TransportBinding, idempotencyKey: string): Promise<DeliveryReceipt>;

	/** Turn provider callbacks into delivery status events; pure. */
	parseStatus(raw: RawInbound): DeliveryStatusEvent[];
}
