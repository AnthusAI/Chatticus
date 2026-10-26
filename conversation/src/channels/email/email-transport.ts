import PostalMime from "postal-mime";
import type { Address, Email } from "postal-mime";
import type {
	AttachmentReference,
	ChannelTransport,
	CommittedMessage,
	DeliveryReceipt,
	DeliveryStatusEvent,
	InboundEvent,
	InboundRefusal,
	OutboundPayload,
	RawInbound,
	ThreadContext,
	TransportBinding,
	TransportCapabilities,
	VerifiedInbound,
} from "../transport.ts";
import { automationHintsFromHeaders } from "./automation-headers.ts";
import {
	ancestorMessageIds,
	emailConversationKey,
	messageIdsOfHeader,
	normalizeEmailAddress,
	normalizeMessageId,
	splitPlusTag,
} from "./email-addresses.ts";
import { htmlToText } from "./html-to-text.ts";
import { stripQuotedReplyAndSignature } from "./quoted-reply.ts";

/** The headers an email `RawInbound` carries beside the raw message: what the mail receiver decided about it. */
export const EMAIL_INBOUND_HEADERS = {
	spfVerdict: "x-inbound-spf-verdict",
	dkimVerdict: "x-inbound-dkim-verdict",
	dmarcVerdict: "x-inbound-dmarc-verdict",
	spamVerdict: "x-inbound-spam-verdict",
	virusVerdict: "x-inbound-virus-verdict",
	envelopeRecipients: "x-inbound-envelope-recipients",
	providerMessageId: "x-inbound-provider-message-id",
	rawReference: "x-inbound-raw-reference",
} as const;

/** The most text of one message that enters a channel. */
export const MAXIMUM_BODY_BYTES = 100_000;

/** The largest raw message the adapter will parse; the mail receiver itself accepts at most 40 MB. */
export const MAXIMUM_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;

/** The text of a message that carried none, for example a message that is only an attachment. */
export const NO_TEXT_PLACEHOLDER = "(This message has no text.)";

/** The line appended to a body that was cut at the limit. */
export const TRUNCATION_NOTICE = "[Message cut at 100 KB; the full original message is kept in the raw mail archive.]";

const MAXIMUM_DISPLAY_NAME_CHARACTERS = 200;

/** The verdicts and identifiers the mail receiver attached to one raw message. */
export interface InboundMailEnvelope {
	readonly spfVerdict: string;
	readonly dkimVerdict: string;
	readonly dmarcVerdict: string;
	readonly spamVerdict: string;
	readonly virusVerdict: string;
	readonly envelopeRecipients: readonly string[];
	readonly providerMessageId: string | null;
	readonly rawReference: string | null;
}

/**
 * Build the `RawInbound` for one received email. The body is the unmodified message with every byte mapped to the
 * character of the same value (Latin-1), so no byte is lost on the way through a string.
 *
 * @param rawMessage The unmodified message bytes.
 * @param envelope What the mail receiver attached to it.
 * @param receivedAt When the receiver accepted it.
 * @returns The request the email transport verifies.
 */
export function emailInboundRequest(rawMessage: Uint8Array, envelope: InboundMailEnvelope, receivedAt: Date): RawInbound {
	const headers: Record<string, string> = {
		[EMAIL_INBOUND_HEADERS.spfVerdict]: envelope.spfVerdict,
		[EMAIL_INBOUND_HEADERS.dkimVerdict]: envelope.dkimVerdict,
		[EMAIL_INBOUND_HEADERS.dmarcVerdict]: envelope.dmarcVerdict,
		[EMAIL_INBOUND_HEADERS.spamVerdict]: envelope.spamVerdict,
		[EMAIL_INBOUND_HEADERS.virusVerdict]: envelope.virusVerdict,
		[EMAIL_INBOUND_HEADERS.envelopeRecipients]: envelope.envelopeRecipients.join(","),
	};
	if (envelope.providerMessageId !== null) headers[EMAIL_INBOUND_HEADERS.providerMessageId] = envelope.providerMessageId;
	if (envelope.rawReference !== null) headers[EMAIL_INBOUND_HEADERS.rawReference] = envelope.rawReference;
	return { provider: "email", headers, body: Buffer.from(rawMessage).toString("latin1"), receivedAt };
}

/** A message the transport verified and parsed; the payload of its `VerifiedInbound`. */
export interface ParsedInboundEmail {
	readonly email: Email;
	readonly envelopeRecipients: readonly string[];
	readonly providerMessageId: string | null;
}

/** Why the email transport refuses a request before any message is read. */
export type EmailRefusalReason = "malformed_message" | "missing_message_id" | "message_too_large" | "sender_not_authenticated" | "spam_or_virus_detected";

const refuse = (reason: EmailRefusalReason): InboundRefusal => ({ kind: "refused", reason });

const isVerdict = (value: string | undefined, expected: string): boolean => value?.trim().toUpperCase() === expected;

interface Mailbox {
	readonly name: string;
	readonly address: string;
}

function mailboxesOf(addresses: readonly Address[] | undefined): Mailbox[] {
	const mailboxes: Mailbox[] = [];
	for (const entry of addresses ?? []) {
		if (entry.group !== undefined) {
			for (const member of entry.group) mailboxes.push({ name: member.name, address: member.address });
		} else {
			mailboxes.push({ name: entry.name, address: entry.address });
		}
	}
	return mailboxes.filter((mailbox) => mailbox.address.includes("@"));
}

function cleanedDisplayName(name: string): string | null {
	const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_DISPLAY_NAME_CHARACTERS);
	return cleaned === "" ? null : cleaned;
}

function cutAtByteLimit(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= MAXIMUM_BODY_BYTES) return text;
	const cut = bytes.subarray(0, MAXIMUM_BODY_BYTES).toString("utf8").replace(/�+$/, "");
	return `${cut.trimEnd()}\n\n${TRUNCATION_NOTICE}`;
}

function attachmentMetadata(email: Email): AttachmentReference[] {
	return email.attachments.map((attachment) => {
		const content = attachment.content;
		const sizeBytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		return { storageKey: null, fileName: attachment.filename ?? "", contentType: attachment.mimeType, sizeBytes };
	});
}

/**
 * The inbound half of the email transport, behind the channel transport port. It reads the unmodified message and the
 * verdicts the mail receiver attached, never touches the network, and produces the provider-neutral inbound event.
 *
 * Only a message whose DMARC verdict passed and whose spam and virus verdicts did not fail is read. The sender is the
 * From address, never Reply-To. The conversation key is the first reference, else the in-reply-to message, else the
 * message itself; the subject plays no part. A plus tag on the bot address is carried as a lookup hint and is never
 * checked here. Rendering and sending belong to the outbound email tasks and are not part of this class yet.
 */
export class EmailChannelTransport implements ChannelTransport {
	readonly provider = "email" as const;
	readonly capabilities: TransportCapabilities = {
		maxBodyCharacters: MAXIMUM_BODY_BYTES,
		conversationGranularity: "thread",
		supportsAttachments: true,
		supportsRichText: "none",
		reportsDelivery: true,
		requiresRecipientOptIn: false,
		authenticatesSender: "per_message",
	};
	private readonly mailDomainSuffix: string;
	private readonly maximumRawMessageBytes: number;

	/**
	 * @param options The environment's mail domain, which tells bot addresses from every other address, and an optional size limit.
	 */
	constructor(options: { readonly mailDomain: string; readonly maximumRawMessageBytes?: number }) {
		this.mailDomainSuffix = `.${options.mailDomain.trim().toLowerCase()}`;
		this.maximumRawMessageBytes = options.maximumRawMessageBytes ?? MAXIMUM_RAW_MESSAGE_BYTES;
	}

	async verifyInbound(raw: RawInbound): Promise<VerifiedInbound | InboundRefusal> {
		if (raw.body.length > this.maximumRawMessageBytes) return refuse("message_too_large");
		if (isVerdict(raw.headers[EMAIL_INBOUND_HEADERS.spamVerdict], "FAIL") || isVerdict(raw.headers[EMAIL_INBOUND_HEADERS.virusVerdict], "FAIL")) {
			return refuse("spam_or_virus_detected");
		}
		if (!isVerdict(raw.headers[EMAIL_INBOUND_HEADERS.dmarcVerdict], "PASS")) return refuse("sender_not_authenticated");
		let email: Email;
		try {
			email = await PostalMime.parse(Buffer.from(raw.body, "latin1"));
		} catch {
			return refuse("malformed_message");
		}
		if (mailboxesOf(email.from === undefined ? undefined : [email.from])[0] === undefined) return refuse("malformed_message");
		const providerMessageId = raw.headers[EMAIL_INBOUND_HEADERS.providerMessageId] ?? null;
		if (normalizeMessageId(email.messageId ?? "") === null && providerMessageId === null) return refuse("missing_message_id");
		const envelopeRecipients = (raw.headers[EMAIL_INBOUND_HEADERS.envelopeRecipients] ?? "")
			.split(",")
			.map(normalizeEmailAddress)
			.filter((address) => address !== "");
		const payload: ParsedInboundEmail = { email, envelopeRecipients, providerMessageId };
		return { kind: "verified", provider: "email", payload, receivedAt: raw.receivedAt, rawReference: raw.headers[EMAIL_INBOUND_HEADERS.rawReference] ?? null };
	}

	normalize(verified: VerifiedInbound): InboundEvent[] {
		const { email, envelopeRecipients, providerMessageId } = verified.payload as ParsedInboundEmail;
		const sender = mailboxesOf(email.from === undefined ? undefined : [email.from])[0]!;
		const senderAddress = normalizeEmailAddress(sender.address);
		const ownMessageId = normalizeMessageId(email.messageId ?? "") ?? `${providerMessageId ?? ""}@inbound.invalid`;
		const inReplyTo = messageIdsOfHeader(email.inReplyTo);
		const references = messageIdsOfHeader(email.references);

		const toAddresses = mailboxesOf(email.to).map((mailbox) => normalizeEmailAddress(mailbox.address));
		const ccAddresses = mailboxesOf(email.cc).map((mailbox) => normalizeEmailAddress(mailbox.address));
		const isBotAddress = (address: string): boolean => splitPlusTag(address).routeAddress.endsWith(this.mailDomainSuffix);
		const routed = [...toAddresses, ...ccAddresses, ...envelopeRecipients].find(isBotAddress) ?? toAddresses[0] ?? envelopeRecipients[0] ?? "";
		const { routeAddress, tag } = splitPlusTag(routed);
		const routeKeys = (addresses: readonly string[]): string[] => [...new Set(addresses.map((address) => splitPlusTag(address).routeAddress))];

		const source = email.text !== undefined && email.text.trim() !== "" ? email.text : email.html === undefined ? "" : htmlToText(email.html);
		const body = cutAtByteLimit(stripQuotedReplyAndSignature(source));

		return [
			{
				provider: "email",
				bindingRouteKey: routeAddress,
				externalMessageId: ownMessageId,
				conversationKey: emailConversationKey(inReplyTo, references, ownMessageId),
				referencedExternalMessageIds: ancestorMessageIds(inReplyTo, references, ownMessageId),
				correlatorHint: tag,
				subject: email.subject === undefined || email.subject.trim() === "" ? null : email.subject.trim(),
				sender: { externalId: senderAddress, displayName: cleanedDisplayName(sender.name), assertion: "dmarc_aligned" },
				text: body.trim() === "" ? NO_TEXT_PLACEHOLDER : body,
				attachments: attachmentMetadata(email),
				addressing: { to: routeKeys(toAddresses), cc: routeKeys(ccAddresses) },
				automationHints: automationHintsFromHeaders(email.headers, senderAddress),
				receivedAt: verified.receivedAt,
				rawReference: verified.rawReference,
			},
		];
	}

	render(_message: CommittedMessage, _binding: TransportBinding, _thread: ThreadContext): OutboundPayload {
		throw new Error("The email transport renders outbound mail in the outbound rendering task, not in the inbound parser");
	}

	async deliver(_payload: OutboundPayload, _binding: TransportBinding, _idempotencyKey: string): Promise<DeliveryReceipt> {
		throw new Error("The email transport sends mail in the SES adapter task, not in the inbound parser");
	}

	parseStatus(_raw: RawInbound): DeliveryStatusEvent[] {
		throw new Error("The email transport reads delivery status in the SES adapter task, not in the inbound parser");
	}
}
