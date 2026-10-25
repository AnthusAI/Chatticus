import {
	TransportDeliveryError,
	type ChannelTransport,
	type CommittedMessage,
	type DeliveryReceipt,
	type DeliveryStatus,
	type DeliveryStatusEvent,
	type InboundEvent,
	type InboundRefusal,
	type OutboundPayload,
	type RawInbound,
	type ThreadContext,
	type TransportBinding,
	type TransportCapabilities,
	type VerifiedInbound,
} from "./transport.ts";

/** The signature header value a fake request must carry to be verified. */
export const FAKE_VALID_SIGNATURE = "valid";

/** The header the fake transport reads its signature from. */
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

/** The fields of an inbound event a test states; everything else gets a neutral default. */
export interface FakeInboundEventInput {
	readonly bindingRouteKey: string;
	readonly externalMessageId: string;
	readonly conversationKey?: string;
	readonly referencedExternalMessageIds?: readonly string[];
	readonly subject?: string | null;
	readonly senderExternalId: string;
	readonly text?: string;
	readonly to?: readonly string[];
	readonly cc?: readonly string[];
}

/** One provider send the fake transport performed. */
export interface FakeSend {
	readonly payload: OutboundPayload;
	readonly binding: TransportBinding;
	readonly idempotencyKey: string;
	readonly receipt: DeliveryReceipt;
}

/** The status callback a test states. */
export interface FakeStatusInput {
	readonly providerMessageId: string;
	readonly status: DeliveryStatus;
	readonly reason?: string | null;
}

const THREAD_CAPABILITIES: TransportCapabilities = {
	maxBodyCharacters: 100_000,
	conversationGranularity: "thread",
	supportsAttachments: false,
	supportsRichText: "none",
	reportsDelivery: true,
	requiresRecipientOptIn: false,
	authenticatesSender: "per_request_signature",
};

/**
 * An in-memory transport that makes every channel behavior testable without a provider. It verifies a signature header,
 * parses JSON events, renders plain text, records every provider send once per idempotency key, and can be told to fail
 * its next sends.
 */
export class FakeChannelTransport implements ChannelTransport {
	readonly provider = "fake" as const;
	readonly sends: FakeSend[] = [];
	deliverCalls = 0;
	private granularity: TransportCapabilities["conversationGranularity"] = "thread";
	private readonly queuedFailures: TransportDeliveryError[] = [];
	private readonly receiptsByKey = new Map<string, DeliveryReceipt>();

	get capabilities(): TransportCapabilities {
		return { ...THREAD_CAPABILITIES, conversationGranularity: this.granularity };
	}

	/** Make conversations of this transport threads or pairs. */
	useGranularity(granularity: TransportCapabilities["conversationGranularity"]): void {
		this.granularity = granularity;
	}

	/** Make the next `count` calls to `deliver` throw this failure. */
	failNextDeliveries(count: number, failure: TransportDeliveryError): void {
		for (let index = 0; index < count; index += 1) this.queuedFailures.push(failure);
	}

	/** A request carrying these events, signed as the fake provider signs. */
	inboundRequest(events: readonly FakeInboundEventInput[], receivedAt: Date, signature: string = FAKE_VALID_SIGNATURE): RawInbound {
		return { provider: "fake", headers: { [FAKE_SIGNATURE_HEADER]: signature }, body: JSON.stringify({ events }), receivedAt };
	}

	/** A callback carrying these status events. */
	statusRequest(events: readonly FakeStatusInput[], receivedAt: Date): RawInbound {
		return { provider: "fake", headers: { [FAKE_SIGNATURE_HEADER]: FAKE_VALID_SIGNATURE }, body: JSON.stringify({ status: events }), receivedAt };
	}

	async verifyInbound(raw: RawInbound): Promise<VerifiedInbound | InboundRefusal> {
		if (raw.headers[FAKE_SIGNATURE_HEADER] !== FAKE_VALID_SIGNATURE) return { kind: "refused", reason: "bad_signature" };
		return { kind: "verified", provider: "fake", payload: JSON.parse(raw.body), receivedAt: raw.receivedAt, rawReference: null };
	}

	normalize(verified: VerifiedInbound): InboundEvent[] {
		const payload = verified.payload as { events?: FakeInboundEventInput[] };
		return (payload.events ?? []).map((input) => ({
			provider: "fake",
			bindingRouteKey: input.bindingRouteKey,
			externalMessageId: input.externalMessageId,
			conversationKey: input.conversationKey ?? input.externalMessageId,
			referencedExternalMessageIds: input.referencedExternalMessageIds ?? [],
			subject: input.subject ?? null,
			sender: { externalId: input.senderExternalId, displayName: null, assertion: "request_signature_user_claim" },
			text: input.text ?? "",
			attachments: [],
			addressing: { to: input.to ?? [], cc: input.cc ?? [] },
			automationHints: { autoSubmitted: false, bulkPrecedence: false, bounceReport: false, listMail: false, ownOrigin: false },
			receivedAt: verified.receivedAt,
			rawReference: null,
		}));
	}

	render(message: CommittedMessage, _binding: TransportBinding, thread: ThreadContext): OutboundPayload {
		return {
			provider: "fake",
			recipientExternalId: thread.recipientExternalId,
			conversationKey: thread.conversationKey,
			inReplyToExternalMessageId: thread.inReplyToExternalMessageId,
			subject: thread.subject,
			text: message.body,
			headers: {},
		};
	}

	async deliver(payload: OutboundPayload, binding: TransportBinding, idempotencyKey: string): Promise<DeliveryReceipt> {
		this.deliverCalls += 1;
		const earlier = this.receiptsByKey.get(idempotencyKey);
		if (earlier !== undefined) return earlier;
		const failure = this.queuedFailures.shift();
		if (failure !== undefined) throw failure;
		const number = this.sends.length + 1;
		const receipt: DeliveryReceipt = { providerMessageId: `fake-provider-${number}`, externalMessageId: `fake-outbound-${number}` };
		this.receiptsByKey.set(idempotencyKey, receipt);
		this.sends.push({ payload, binding, idempotencyKey, receipt });
		return receipt;
	}

	parseStatus(raw: RawInbound): DeliveryStatusEvent[] {
		if (raw.headers[FAKE_SIGNATURE_HEADER] !== FAKE_VALID_SIGNATURE) return [];
		const parsed = JSON.parse(raw.body) as { status?: FakeStatusInput[] };
		return (parsed.status ?? []).map((entry) => ({ provider: "fake", providerMessageId: entry.providerMessageId, status: entry.status, reason: entry.reason ?? null }));
	}
}
