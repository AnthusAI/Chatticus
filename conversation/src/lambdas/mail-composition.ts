import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { dropAutomatedMessages, type AdmissionDependencies } from "../channels/inbound-admission.ts";
import { handleChannelMessageCreated, type ChannelMessageCreatedBusEvent, type DeliveryInvocationResult } from "../channels/email/mail-delivery-handler.ts";
import { handleMailReceipt, type SesReceiptEvent } from "../channels/email/mail-ingress-handler.ts";
import { handleSesStatusEvent, type SnsEvent } from "../channels/email/mail-status-handler.ts";
import { S3RawMailReader, type S3ObjectReader } from "../channels/email/raw-mail-store.ts";
import { HttpsSigningCertificateSource, type SigningCertificateSource } from "../channels/email/sns-signature.ts";
import type { EmailChannelTransport } from "../channels/email/email-transport.ts";
import { loadCommittedMessage } from "../channels/message-loader.ts";
import type { ChannelsRuntime } from "../channels/runtime.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoRecipientSuppressionList } from "../store/recipient-suppression-store.ts";
import { composeChannelsRuntime, type ChannelsAwsClients } from "./channels-composition.ts";
import { composeChannelListing, composeMessageDependencies, requiredVariable } from "./message-dependencies.ts";

/** Names the raw mail bucket the ingress function reads. */
export const CHANNELS_RAW_MAIL_BUCKET_VARIABLE = "CHATTICUS_CHANNELS_RAW_MAIL_BUCKET";

/** Names the SNS topic ARN of the configuration set; the status function believes notifications of that topic only. */
export const CHANNELS_MAIL_EVENTS_TOPIC_ARN_VARIABLE = "CHATTICUS_CHANNELS_MAIL_EVENTS_TOPIC_ARN";

/** The AWS clients the mail functions are built from; tests inject fakes. */
export type MailAwsClients = Omit<ChannelsAwsClients, "parameters"> & {
	readonly parameters: ChannelsAwsClients["parameters"];
	readonly s3: S3Client;
	readonly sqs: SQSClient;
	readonly archive?: S3ObjectReader;
	readonly certificates?: SigningCertificateSource;
};

/** The clients of a deployed mail function, built from the function's own role. */
export function defaultMailAwsClients(): MailAwsClients {
	return { dynamo: new DynamoDBClient({}), parameters: new SSMClient({}), s3: new S3Client({}), sqs: new SQSClient({}) };
}

const SYSTEM_CLOCK = { now: () => new Date() };

async function requiredRuntime(environment: Record<string, string | undefined>, clients: MailAwsClients): Promise<{ runtime: ChannelsRuntime; table: string }> {
	const table = requiredVariable(environment, "CHATTICUS_MESSAGING_TABLE");
	const runtime = await composeChannelsRuntime(environment, clients, table);
	if (runtime === null) throw new Error("External channels do not exist in this deployment: the mail domain is not set.");
	return { runtime, table };
}

function emailTransportOf(runtime: ChannelsRuntime): EmailChannelTransport {
	const transport = runtime.transports.get("email");
	if (transport === undefined) throw new Error("The channel runtime has no email transport.");
	return transport as EmailChannelTransport;
}

/**
 * Build the handler of the mail ingress function: the admission path of the front door, the raw mail archive and the email transport.
 *
 * @param environment The environment variables.
 * @param clients The AWS clients.
 * @param clock The clock.
 * @returns The handler of a receipt event.
 */
export async function composeMailIngressHandler(
	environment: Record<string, string | undefined>,
	clients: MailAwsClients,
	clock: { now(): Date } = SYSTEM_CLOCK,
): Promise<(event: SesReceiptEvent) => Promise<void>> {
	const { runtime, table } = await requiredRuntime(environment, clients);
	const bucket = requiredVariable(environment, CHANNELS_RAW_MAIL_BUCKET_VARIABLE);
	const store = new DynamoMessagingStore(clients.dynamo, table);
	const ids = { next: () => randomUUID() };
	const admission: AdmissionDependencies = {
		runtime,
		messaging: store,
		messages: { store, ids, clock, ...composeMessageDependencies(environment, clients, table) },
		ids,
		clock,
		automation: dropAutomatedMessages,
	};
	const deps = { admission, transport: emailTransportOf(runtime), archive: new S3RawMailReader(clients.archive ?? clients.s3, bucket), archiveBucket: bucket };
	return async (event) => {
		await handleMailReceipt(deps, event);
	};
}

/**
 * Build the handler of the delivery function: the delivery path with the real email transport.
 *
 * @param environment The environment variables.
 * @param clients The AWS clients.
 * @param clock The clock.
 * @returns The handler of a bus event.
 */
export async function composeMailDeliveryHandler(
	environment: Record<string, string | undefined>,
	clients: MailAwsClients,
	clock: { now(): Date } = SYSTEM_CLOCK,
): Promise<(event: ChannelMessageCreatedBusEvent) => Promise<DeliveryInvocationResult>> {
	const { runtime, table } = await requiredRuntime(environment, clients);
	const messaging = new DynamoMessagingStore(clients.dynamo, table);
	const listing = composeChannelListing(environment, clients, table);
	const deps = { runtime, clock, messaging, loadMessage: (tenantId: string, channelId: string, seq: number) => loadCommittedMessage({ messaging, listing }, tenantId, channelId, seq) };
	return (event) => handleChannelMessageCreated(deps, event);
}

/**
 * Build the handler of the status function: signature verification for the configured topic, then the status callback.
 *
 * @param environment The environment variables.
 * @param clients The AWS clients.
 * @param clock The clock.
 * @returns The handler of an SNS event.
 */
export async function composeMailStatusHandler(
	environment: Record<string, string | undefined>,
	clients: MailAwsClients,
	clock: { now(): Date } = SYSTEM_CLOCK,
): Promise<(event: SnsEvent) => Promise<void>> {
	const { runtime, table } = await requiredRuntime(environment, clients);
	const deps = {
		runtime,
		clock,
		transport: emailTransportOf(runtime),
		suppressionList: new DynamoRecipientSuppressionList(clients.dynamo, table),
		certificates: clients.certificates ?? new HttpsSigningCertificateSource(() => clock.now()),
		expectedTopicArn: requiredVariable(environment, CHANNELS_MAIL_EVENTS_TOPIC_ARN_VARIABLE),
		region: requiredVariable(environment, "AWS_REGION"),
	};
	return async (event) => {
		await handleSesStatusEvent(deps, event);
	};
}

/**
 * Keep the composition of a function for the life of its process, and forget a failed one so the next invocation tries again.
 *
 * @param compose Builds the handler.
 * @returns The handler, composed on first use.
 */
export function lazyHandler<Event, Result>(compose: () => Promise<(event: Event) => Promise<Result>>): (event: Event) => Promise<Result> {
	let composed: Promise<(event: Event) => Promise<Result>> | null = null;
	return async (event) => {
		composed ??= compose().catch((error: unknown) => {
			composed = null;
			throw error;
		});
		return (await composed)(event);
	};
}
