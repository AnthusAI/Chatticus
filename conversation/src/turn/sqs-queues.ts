import { ChangeMessageVisibilityCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ComputerStartJob, ComputerStartQueue } from "../domain/computer-start.ts";
import type {
	TurnProbeMessage,
	TurnProbeQueue,
	TurnRunJob,
	TurnRunQueue,
	TurnRunVisibility,
} from "../domain/turn-admission.ts";

/** Seconds a run job stays invisible after each renewal; six times the function timeout, as the queue is configured. */
export const RUN_VISIBILITY_SECONDS = 1800;

/** TurnRuns over SQS. */
export class SqsTurnRunQueue implements TurnRunQueue {
	private readonly client: SQSClient;
	private readonly queueUrl: string;

	constructor(client: SQSClient, queueUrl: string) {
		this.client = client;
		this.queueUrl = queueUrl;
	}

	async enqueue(job: TurnRunJob): Promise<void> {
		await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }));
	}
}

/** TurnProbes over an SQS delay queue; each message carries its own delay. */
export class SqsTurnProbeQueue implements TurnProbeQueue {
	private readonly client: SQSClient;
	private readonly queueUrl: string;

	constructor(client: SQSClient, queueUrl: string) {
		this.client = client;
		this.queueUrl = queueUrl;
	}

	async send(message: TurnProbeMessage, delaySeconds: number): Promise<void> {
		await this.client.send(
			new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message), DelaySeconds: delaySeconds }),
		);
	}
}

/** Extends the visibility of the one TurnRuns message the current invocation is working on. */
export class SqsRunVisibility implements TurnRunVisibility {
	private readonly client: SQSClient;
	private readonly queueUrl: string;
	private readonly receiptHandle: string;

	constructor(client: SQSClient, queueUrl: string, receiptHandle: string) {
		this.client = client;
		this.queueUrl = queueUrl;
		this.receiptHandle = receiptHandle;
	}

	async extend(): Promise<void> {
		await this.client.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: this.queueUrl,
				ReceiptHandle: this.receiptHandle,
				VisibilityTimeout: RUN_VISIBILITY_SECONDS,
			}),
		);
	}
}

/** ComputerStartJobs over SQS. */
export class SqsComputerStartQueue implements ComputerStartQueue {
	private readonly client: SQSClient;
	private readonly queueUrl: string;

	constructor(client: SQSClient, queueUrl: string) {
		this.client = client;
		this.queueUrl = queueUrl;
	}

	async enqueue(job: ComputerStartJob): Promise<void> {
		await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }));
	}
}
