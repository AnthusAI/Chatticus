import { SesSendError, type SesMailClient, type SesSendFailureKind, type SesSendRequest, type SesSendResult } from "../src/channels/email/ses-mail-client.ts";

/** An in-memory SES client that records every send and can be told to fail the next ones. */
export class FakeSesMailClient implements SesMailClient {
	readonly sends: Array<{ readonly request: SesSendRequest; readonly messageId: string }> = [];
	sendCalls = 0;
	private readonly queuedFailures: SesSendFailureKind[] = [];

	/** Make the next send fail as SES would. */
	failNextSend(kind: SesSendFailureKind): void {
		this.queuedFailures.push(kind);
	}

	async sendRawEmail(request: SesSendRequest): Promise<SesSendResult> {
		this.sendCalls += 1;
		const failure = this.queuedFailures.shift();
		if (failure !== undefined) throw new SesSendError(failure);
		const messageId = `ses-message-${this.sends.length + 1}`;
		this.sends.push({ request, messageId });
		return { messageId };
	}
}
