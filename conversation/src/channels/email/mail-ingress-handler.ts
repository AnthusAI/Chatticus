import { ingestInbound, type AdmissionDependencies, type AdmissionOutcome } from "../inbound-admission.ts";
import type { ChannelTransport } from "../transport.ts";
import { emailInboundRequest, type InboundMailEnvelope } from "./email-transport.ts";
import type { RawMailReader } from "./raw-mail-store.ts";

/** Where the mail receiver stores the raw message of each received mail, below the message id. */
export const RAW_MAIL_KEY_PREFIX = "raw/";

const SES_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

type Verdict = { readonly status?: unknown };

/** The receipt part of one SES event record that the ingress reads. */
export interface SesReceipt {
	readonly timestamp?: unknown;
	readonly recipients?: unknown;
	readonly spfVerdict?: Verdict;
	readonly dkimVerdict?: Verdict;
	readonly dmarcVerdict?: Verdict;
	readonly spamVerdict?: Verdict;
	readonly virusVerdict?: Verdict;
}

/** One record of the event SES hands a Lambda receipt rule action. */
export interface SesReceiptRecord {
	readonly ses?: { readonly mail?: { readonly messageId?: unknown }; readonly receipt?: SesReceipt };
}

/** The event SES hands the ingress function. */
export interface SesReceiptEvent {
	readonly Records?: readonly SesReceiptRecord[];
}

/** Raised when a message another invocation claimed has not finished, so the provider's retry runs this one again after the claim lease. */
export class InboundInFlightError extends Error {
	readonly sesMessageId: string;

	constructor(sesMessageId: string) {
		super(`The message ${sesMessageId} is claimed by another invocation and not finished; the provider retries it.`);
		this.name = "InboundInFlightError";
		this.sesMessageId = sesMessageId;
	}
}

/** Raised when the archive has no object for a message SES says it stored, which may still be on its way. */
export class RawMailMissingError extends Error {
	readonly key: string;

	constructor(key: string) {
		super(`The raw mail archive has no object ${key}.`);
		this.name = "RawMailMissingError";
		this.key = key;
	}
}

/** What the ingress function reads and writes. */
export interface MailIngressDependencies {
	readonly admission: AdmissionDependencies;
	readonly transport: ChannelTransport;
	readonly archive: RawMailReader;
	readonly archiveBucket: string;
}

const verdictOf = (verdict: Verdict | undefined): string => (typeof verdict?.status === "string" ? verdict.status : "");

function receivedAtOf(receipt: SesReceipt, fallback: Date): Date {
	const stamped = typeof receipt.timestamp === "string" ? new Date(receipt.timestamp) : null;
	return stamped === null || Number.isNaN(stamped.getTime()) ? fallback : stamped;
}

function recipientsOf(receipt: SesReceipt): string[] {
	return Array.isArray(receipt.recipients) ? receipt.recipients.filter((recipient): recipient is string => typeof recipient === "string") : [];
}

/**
 * Handle the receipt event of the mail receiver: for each record read the raw message the receiver stored, take the verdicts
 * from the receipt, never from the message, and admit the message through the shared inbound path. A message that is
 * refused or dropped for a lasting reason is counted by the admission path and does not fail the function. A message whose
 * claim another invocation holds, and one whose archive object is missing, fail it after every record was tried, so the
 * provider retries the whole event; the retry is harmless because admission recognizes what it already admitted.
 *
 * @param deps The admission path, the transport and the raw archive.
 * @param event The receipt event.
 * @returns The outcome of every message that was admitted or dropped.
 * @throws InboundInFlightError When a message is claimed and unfinished.
 * @throws RawMailMissingError When the archive has no object for a message.
 */
export async function handleMailReceipt(deps: MailIngressDependencies, event: SesReceiptEvent): Promise<AdmissionOutcome[]> {
	const outcomes: AdmissionOutcome[] = [];
	let failure: Error | null = null;
	for (const record of event.Records ?? []) {
		const messageId = record.ses?.mail?.messageId;
		const receipt = record.ses?.receipt ?? {};
		if (typeof messageId !== "string" || !SES_MESSAGE_ID_PATTERN.test(messageId)) {
			deps.admission.runtime.metrics.count("inbound_refused", { provider: "email", reason: "invalid_event" });
			continue;
		}
		const key = `${RAW_MAIL_KEY_PREFIX}${messageId}`;
		const raw = await deps.archive.read(key);
		if (raw === null) {
			failure ??= new RawMailMissingError(key);
			continue;
		}
		const envelope: InboundMailEnvelope = {
			spfVerdict: verdictOf(receipt.spfVerdict),
			dkimVerdict: verdictOf(receipt.dkimVerdict),
			dmarcVerdict: verdictOf(receipt.dmarcVerdict),
			spamVerdict: verdictOf(receipt.spamVerdict),
			virusVerdict: verdictOf(receipt.virusVerdict),
			envelopeRecipients: recipientsOf(receipt),
			providerMessageId: messageId,
			rawReference: `s3://${deps.archiveBucket}/${key}`,
		};
		const request = emailInboundRequest(raw, envelope, receivedAtOf(receipt, deps.admission.clock.now()));
		const result = await ingestInbound(deps.admission, deps.transport, request);
		if (result.kind === "refused") continue;
		for (const outcome of result.outcomes) {
			outcomes.push(outcome);
			if (outcome.kind === "dropped" && outcome.reason === "in_flight") failure ??= new InboundInFlightError(messageId);
		}
	}
	if (failure !== null) throw failure;
	return outcomes;
}
