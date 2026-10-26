import { SendEmailCommand, type SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { SesSendError, type SesMailClient, type SesSendFailureKind, type SesSendRequest, type SesSendResult } from "./ses-mail-client.ts";

/** The part of an SES v2 client the adapter uses; a real client or a fake satisfies it. */
export interface SesV2Sender {
	send(command: SendEmailCommand): Promise<Pick<SendEmailCommandOutput, "MessageId">>;
}

const THROTTLED_NAMES = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException", "Throttling"]);
const UNAVAILABLE_NAMES = new Set(["InternalServiceErrorException", "InternalFailure", "ServiceUnavailable", "ServiceUnavailableException", "TimeoutError"]);
const REJECTED_NAMES = new Set([
	"AccountSuspendedException",
	"SendingPausedException",
	"MailFromDomainNotVerifiedException",
	"NotFoundException",
	"BadRequestException",
]);

/**
 * How an SES v2 failure is classified for the delivery record, or null when the failure is not one SES decided about the message.
 *
 * @param error What the SDK threw.
 * @returns The classification, or null for any other error.
 */
export function classifySesV2Failure(error: unknown): SesSendFailureKind | null {
	const name = (error as { name?: string } | null)?.name ?? "";
	const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode ?? 0;
	const message = error instanceof Error ? error.message : "";
	if (THROTTLED_NAMES.has(name)) return "throttled";
	if (UNAVAILABLE_NAMES.has(name) || status >= 500) return "unavailable";
	if (name === "MessageRejected") {
		if (/is not verified|identities failed the check/i.test(message)) return "sandbox_unverified_recipient";
		if (/suppression/i.test(message)) return "suppressed";
		return "rejected";
	}
	if (REJECTED_NAMES.has(name)) return "rejected";
	return null;
}

/** Sends raw messages through SES v2 `SendEmail` and maps the provider's exceptions to `SesSendError`. */
export class SesV2MailClient implements SesMailClient {
	private readonly client: SesV2Sender;

	/**
	 * @param client An SES v2 client built from the Lambda's own role.
	 */
	constructor(client: SesV2Sender) {
		this.client = client;
	}

	async sendRawEmail(request: SesSendRequest): Promise<SesSendResult> {
		try {
			const response = await this.client.send(
				new SendEmailCommand({
					FromEmailAddress: request.fromAddress,
					Destination: { ToAddresses: [...request.destinations] },
					Content: { Raw: { Data: request.rawMessage } },
					ConfigurationSetName: request.configurationSetName,
				}),
			);
			if (response.MessageId === undefined || response.MessageId === "") throw new SesSendError("unavailable");
			return { messageId: response.MessageId };
		} catch (error) {
			if (error instanceof SesSendError) throw error;
			const kind = classifySesV2Failure(error);
			if (kind === null) throw error;
			throw new SesSendError(kind);
		}
	}
}
