import PostalMime, { addressParser } from "postal-mime";
import type { Address, Email, PostalMimeOptions } from "postal-mime";
import type { ChannelMetrics } from "../metrics.ts";
import { channelCorrelatorTag } from "../channel-correlator.ts";
import {
	TransportDeliveryError,
	type AttachmentReference,
	type ChannelTransport,
	type CommittedMessage,
	type DeliveryReceipt,
	type DeliveryStatusEvent,
	type InboundEvent,
	type InboundRefusal,
	type OutboundPayload,
	type RawInbound,
	type ThreadContext,
	type TransportBinding,
	type TransportCapabilities,
	type VerifiedInbound,
} from "../transport.ts";
import { sanitizedAttachmentFileName, sanitizedContentType } from "./attachment-metadata.ts";
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
import { isOwnOutboundMessageId, outboundMessageId } from "./outbound-message-id.ts";
import { outboundMimeBytes, replySubject } from "./outbound-mime.ts";
import type { RecipientSuppressionList } from "./recipient-suppression.ts";
import { SesSendError, type SesMailClient } from "./ses-mail-client.ts";
import { sesStatusFacts, type SesStatusFact } from "./ses-event-notification.ts";
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
const MAXIMUM_SCANNED_CONTENT_TYPES = 1000;

/** The limits handed to the MIME parser so that one hostile message cannot cost more than a bounded amount of work. */
export const PARSER_LIMITS: PostalMimeOptions = {
	maxHeadersSize: 131_072,
	maxNestingDepth: 16,
	maxPartCount: 200,
	maxRfc822NestingDepth: 2,
};

const knownCharsets = new Map<string, boolean>();

function charsetIsKnown(label: string): boolean {
	let known = knownCharsets.get(label);
	if (known === undefined) {
		try {
			new TextDecoder(label);
			known = true;
		} catch {
			known = false;
		}
		knownCharsets.set(label, known);
	}
	return known;
}

function declaresUnknownCharset(rawMessage: string): boolean {
	let scanned = 0;
	for (const header of rawMessage.matchAll(/^content-type:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/gim)) {
		scanned += 1;
		if (scanned > MAXIMUM_SCANNED_CONTENT_TYPES) return false;
		const label = /charset\s*=\s*"?([^\s";]+)/i.exec(header[0])?.[1];
		if (label !== undefined && !charsetIsKnown(label.toLowerCase())) return true;
	}
	return false;
}

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
	readonly sender: Mailbox;
	readonly envelopeRecipients: readonly string[];
	readonly providerMessageId: string | null;
}

/** Why the email transport refuses a request before any message is read. */
export type EmailRefusalReason = "malformed_message" | "missing_message_id" | "message_too_large" | "sender_not_authenticated" | "spam_or_virus_detected" | "own_outbound_message_id";

const refuse = (reason: EmailRefusalReason): InboundRefusal => ({ kind: "refused", reason });

const isVerdict = (value: string | undefined, expected: string): boolean => value?.trim().toUpperCase() === expected;

/** One address with its decoded display name. */
export interface Mailbox {
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

function soleSender(email: Email): Mailbox | null {
	const fromHeaders = email.headers.filter((header) => header.key === "from");
	if (fromHeaders.length !== 1) return null;
	const parsed = addressParser(fromHeaders[0]!.value);
	const only = parsed[0];
	if (parsed.length !== 1 || only === undefined || only.group !== undefined || only.address === undefined || !only.address.includes("@")) return null;
	return { name: only.name, address: only.address };
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
		return { storageKey: null, fileName: sanitizedAttachmentFileName(attachment.filename), contentType: sanitizedContentType(attachment.mimeType), sizeBytes };
	});
}

/**
 * The inbound half of the email transport, behind the channel transport port. It reads the unmodified message and the
 * verdicts the mail receiver attached, never touches the network, and produces the provider-neutral inbound event.
 *
 * Only a message whose DMARC verdict passed and whose spam and virus verdicts did not fail is read. The sender is the
 * From address, never Reply-To. The conversation key is the first reference, else the in-reply-to message, else the
 * message itself; the subject plays no part. A plus tag on the bot address is carried as a lookup hint and is never
 * checked here. A message whose own Message-ID is one our outbound mail carries is refused, whatever its other headers say.
 *
 * The outbound half renders a committed reply as one plain text message, sends it through SES v2 and reads the SES event
 * notifications that follow. A reply is from the bot's address, to the sender it answers and nobody else, and threads by
 * In-Reply-To and References. The thread's earlier replies are not on the port, so References is the thread root and the
 * message answered. A Message-ID is derived from the reply, so a repeated render is the same id.
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
	private readonly mailDomain: string;
	private readonly mailDomainSuffix: string;
	private readonly maximumRawMessageBytes: number;
	private readonly metrics: ChannelMetrics;
	private readonly correlatorSecret: string;
	private readonly mailClient: SesMailClient;
	private readonly configurationSetName: string;
	private readonly suppressionList: RecipientSuppressionList;
	private readonly webAppBaseUrl: string;
	private readonly receiptsByIdempotencyKey = new Map<string, DeliveryReceipt>();

	/**
	 * @param options The environment's mail domain, which tells bot addresses from every other address; the metrics sink;
	 * the deployment's correlator secret, which keys plus tags and our own Message-IDs; the SES client and the configuration
	 * set every send goes through; the suppression list; the web app's base URL for the link in a cut reply; and an optional
	 * inbound size limit.
	 */
	constructor(options: {
		readonly mailDomain: string;
		readonly metrics: ChannelMetrics;
		readonly correlatorSecret: string;
		readonly mailClient: SesMailClient;
		readonly configurationSetName: string;
		readonly suppressionList: RecipientSuppressionList;
		readonly webAppBaseUrl: string;
		readonly maximumRawMessageBytes?: number;
	}) {
		this.metrics = options.metrics;
		this.mailDomain = options.mailDomain.trim().toLowerCase();
		this.mailDomainSuffix = `.${this.mailDomain}`;
		this.correlatorSecret = options.correlatorSecret;
		this.mailClient = options.mailClient;
		this.configurationSetName = options.configurationSetName;
		this.suppressionList = options.suppressionList;
		this.webAppBaseUrl = options.webAppBaseUrl.replace(/\/+$/, "");
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
			email = await PostalMime.parse(Buffer.from(raw.body, "latin1"), PARSER_LIMITS);
		} catch {
			return refuse("malformed_message");
		}
		const sender = soleSender(email);
		if (sender === null) return refuse("malformed_message");
		if (isOwnOutboundMessageId(this.correlatorSecret, this.mailDomain, email.messageId ?? "")) return refuse("own_outbound_message_id");
		if (declaresUnknownCharset(raw.body)) this.metrics.count("inbound_charset_fallback", { provider: "email" });
		const providerMessageId = raw.headers[EMAIL_INBOUND_HEADERS.providerMessageId] ?? null;
		if (normalizeMessageId(email.messageId ?? "") === null && providerMessageId === null) return refuse("missing_message_id");
		const envelopeRecipients = (raw.headers[EMAIL_INBOUND_HEADERS.envelopeRecipients] ?? "")
			.split(",")
			.map(normalizeEmailAddress)
			.filter((address) => address !== "");
		const payload: ParsedInboundEmail = { email, sender, envelopeRecipients, providerMessageId };
		return { kind: "verified", provider: "email", payload, receivedAt: raw.receivedAt, rawReference: raw.headers[EMAIL_INBOUND_HEADERS.rawReference] ?? null };
	}

	normalize(verified: VerifiedInbound): InboundEvent[] {
		const { email, sender, envelopeRecipients, providerMessageId } = verified.payload as ParsedInboundEmail;
		const senderAddress = normalizeEmailAddress(sender.address);
		const ownMessageId = normalizeMessageId(email.messageId ?? "") ?? `${providerMessageId ?? ""}@inbound.invalid`;
		const inReplyTo = messageIdsOfHeader(email.inReplyTo);
		const references = messageIdsOfHeader(email.references);

		const toAddresses = mailboxesOf(email.to).map((mailbox) => normalizeEmailAddress(mailbox.address));
		const ccAddresses = mailboxesOf(email.cc).map((mailbox) => normalizeEmailAddress(mailbox.address));
		const isBotAddress = (address: string): boolean => splitPlusTag(address).routeAddress.endsWith(this.mailDomainSuffix);
		const deliveredBotAddresses = envelopeRecipients.filter(isBotAddress);
		const routed =
			deliveredBotAddresses.find((delivered) => toAddresses.some((address) => splitPlusTag(address).routeAddress === splitPlusTag(delivered).routeAddress)) ??
			deliveredBotAddresses[0] ??
			"";
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

	render(message: CommittedMessage, binding: TransportBinding, thread: ThreadContext): OutboundPayload {
		const botAddress = normalizeEmailAddress(binding.routeKey);
		const recipient = normalizeEmailAddress(thread.recipientExternalId);
		const inReplyTo = normalizeMessageId(thread.inReplyToExternalMessageId) ?? thread.inReplyToExternalMessageId;
		const rootMessageId = normalizeMessageId(thread.conversationKey) ?? inReplyTo;
		const references = [...new Set([rootMessageId, inReplyTo])];
		const ownMessageId = outboundMessageId(this.correlatorSecret, this.mailDomain, { tenantId: message.tenantId, messageId: message.messageId, bindingId: binding.bindingId });
		const { routeAddress } = splitPlusTag(botAddress);
		const at = routeAddress.lastIndexOf("@");
		const tag = channelCorrelatorTag(this.correlatorSecret, message.tenantId, message.channelId);
		const replyToAddress = at <= 0 ? routeAddress : `${routeAddress.slice(0, at)}+${tag}${routeAddress.slice(at)}`;
		const wrapped = (id: string): string => `<${id}>`;
		const subject = replySubject(thread.subject);
		return {
			provider: "email",
			recipientExternalId: recipient,
			conversationKey: thread.conversationKey,
			inReplyToExternalMessageId: inReplyTo,
			subject,
			text: this.boundedReplyText(message.body),
			headers: {
				From: routeAddress,
				To: recipient,
				"Reply-To": replyToAddress,
				Date: message.createdAt.toUTCString(),
				"Message-ID": wrapped(ownMessageId),
				"In-Reply-To": wrapped(inReplyTo),
				References: references.map(wrapped).join(" "),
				"Auto-Submitted": "auto-replied",
				"X-Chatticus-Origin": this.mailDomain,
				"X-Chatticus-Hops": "1",
			},
		};
	}

	private boundedReplyText(body: string): string {
		if (body.length <= MAXIMUM_BODY_BYTES) return body;
		const cut = body.slice(0, MAXIMUM_BODY_BYTES).replace(/[\ud800-\udbff]$/, "");
		return `${cut.trimEnd()}\n\n[This reply was cut at ${MAXIMUM_BODY_BYTES.toLocaleString("en-US")} characters. Read all of it in Chatticus: ${this.webAppBaseUrl}/chat]`;
	}

	async deliver(payload: OutboundPayload, binding: TransportBinding, idempotencyKey: string): Promise<DeliveryReceipt> {
		const earlier = this.receiptsByIdempotencyKey.get(idempotencyKey);
		if (earlier !== undefined) return earlier;
		const recipient = payload.recipientExternalId;
		const fromAddress = payload.headers["From"] ?? "";
		if (!isSingleAddress(recipient) || !isSingleAddress(fromAddress)) throw new TransportDeliveryError("permanent", "invalid_recipient");
		if (await this.suppressionList.isSuppressed(binding.tenantId, binding.bindingId, recipient)) throw new TransportDeliveryError("suppressed", "recipient_suppressed");
		const rawMessage = outboundMimeBytes({ headers: Object.entries(payload.headers), subject: payload.subject ?? "", text: payload.text });
		let providerMessageId: string;
		try {
			providerMessageId = (await this.mailClient.sendRawEmail({ fromAddress, destinations: [recipient], rawMessage, configurationSetName: this.configurationSetName })).messageId;
		} catch (error) {
			throw classifiedSendFailure(error);
		}
		const externalMessageId = normalizeMessageId(payload.headers["Message-ID"] ?? "") ?? "";
		const receipt: DeliveryReceipt = { providerMessageId, externalMessageId };
		this.receiptsByIdempotencyKey.set(idempotencyKey, receipt);
		return receipt;
	}

	parseStatus(raw: RawInbound): DeliveryStatusEvent[] {
		return this.statusFacts(raw).map((fact) => fact.event);
	}

	/**
	 * The status events of one SES notification together with the addresses each one suppresses. The suppression is a
	 * side effect, so it belongs to the callback processor and not to the pure `parseStatus`.
	 *
	 * @param raw The notification exactly as the SNS subscription delivered it.
	 * @returns The facts, in order.
	 */
	statusFacts(raw: RawInbound): SesStatusFact[] {
		return sesStatusFacts(raw.body);
	}
}

const SINGLE_ADDRESS_PATTERN = /^[^\s<>(),;:"\\[\]@]+@[^\s<>(),;:"\\[\]@]+$/;

function isSingleAddress(address: string): boolean {
	return SINGLE_ADDRESS_PATTERN.test(address);
}

function classifiedSendFailure(error: unknown): TransportDeliveryError {
	if (!(error instanceof SesSendError)) return new TransportDeliveryError("retryable", "ses_unavailable");
	switch (error.kind) {
		case "throttled":
			return new TransportDeliveryError("retryable", "ses_throttled");
		case "unavailable":
			return new TransportDeliveryError("retryable", "ses_unavailable");
		case "sandbox_unverified_recipient":
			return new TransportDeliveryError("permanent", "sandbox_recipient_not_verified");
		case "suppressed":
			return new TransportDeliveryError("suppressed", "ses_account_suppressed");
		case "rejected":
			return new TransportDeliveryError("permanent", "ses_rejected");
	}
}
