/** One message handed to SES v2 `SendEmail` with raw content. */
export interface SesSendRequest {
	readonly fromAddress: string;
	readonly destinations: readonly string[];
	readonly rawMessage: Uint8Array;
	readonly configurationSetName: string;
}

/** What SES answered for an accepted send. */
export interface SesSendResult {
	readonly messageId: string;
}

/** How SES refused a send, as the adapter maps the provider's own exception. */
export type SesSendFailureKind = "throttled" | "unavailable" | "rejected" | "sandbox_unverified_recipient" | "suppressed";

/** The error an SES client throws for a send SES did not accept. */
export class SesSendError extends Error {
	readonly kind: SesSendFailureKind;

	/**
	 * @param kind How SES refused the send.
	 */
	constructor(kind: SesSendFailureKind) {
		super(`SES refused the send: ${kind}`);
		this.name = "SesSendError";
		this.kind = kind;
	}
}

/**
 * The seam to SES v2. The real client maps the provider's exceptions to `SesSendError`; tests use a fake. No code in the
 * email transport imports the AWS SDK.
 */
export interface SesMailClient {
	/** Send one raw message; throws `SesSendError` for a refusal and any other error for a failure of the call itself. */
	sendRawEmail(request: SesSendRequest): Promise<SesSendResult>;
}
