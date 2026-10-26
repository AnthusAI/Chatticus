import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { ReplyDeliveryRecorder } from "../channels/delivery.ts";
import { EmailChannelTransport } from "../channels/email/email-transport.ts";
import { EventBridgeChannelEventPublisher, gatedReplyDeliveryRecorder, type EventPutter } from "../channels/eventbridge-publisher.ts";
import type { ChannelMetrics } from "../channels/metrics.ts";
import type { ChannelsRuntime } from "../channels/runtime.ts";
import type { ChannelTransport, TransportProvider } from "../channels/transport.ts";
import { DynamoChannelStore } from "../store/channel-store.ts";
import type { ParameterReader } from "./openai-key.ts";

/** Names the mail domain of the environment. External channels exist in a deployment only where this is set. */
export const CHANNELS_MAIL_DOMAIN_VARIABLE = "CHATTICUS_CHANNELS_MAIL_DOMAIN";

/** Names the SSM SecureString parameter that holds the secret keying the plus-tag hash. Required wherever the mail domain is set. */
export const CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME_VARIABLE = "CHATTICUS_CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME";

/** Names the EventBridge bus that receives the reply-delivery event. Required wherever the mail domain is set. */
export const CHANNELS_EVENT_BUS_NAME_VARIABLE = "CHATTICUS_CHANNELS_EVENT_BUS_NAME";

/** Names the environment kill switch: `engaged` or `released`. Absent means engaged, so nothing is admitted or delivered until a deployment releases it. */
export const CHANNELS_KILL_SWITCH_VARIABLE = "CHATTICUS_CHANNELS_KILL_SWITCH";

/** The AWS clients the channel composition is built from; tests inject fakes or emulator-backed clients. */
export type ChannelsAwsClients = {
	readonly dynamo: DynamoDBClient;
	readonly parameters: ParameterReader;
	/** Built from the Lambda's own role when absent. */
	readonly events?: EventPutter;
};

const named = (environment: Record<string, string | undefined>, name: string): string => {
	const value = environment[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required when ${CHANNELS_MAIL_DOMAIN_VARIABLE} is set.`);
	return value;
};

function killSwitchEngagedIn(environment: Record<string, string | undefined>): boolean {
	const value = environment[CHANNELS_KILL_SWITCH_VARIABLE] ?? "";
	if (value === "" || value === "engaged") return true;
	if (value === "released") return false;
	throw new Error(`The environment variable ${CHANNELS_KILL_SWITCH_VARIABLE} must be "engaged" or "released".`);
}

/** Counts channel events as one structured log line each: the name and its dimensions, never a message text or an address. */
export const LOGGING_CHANNEL_METRICS: ChannelMetrics = {
	count: (name, dimensions = {}) => console.log(JSON.stringify({ component: "channels", metric: name, ...dimensions })),
};

function eventsOf(clients: Pick<ChannelsAwsClients, "events">): EventPutter {
	return clients.events ?? new EventBridgeClient({});
}

/**
 * Build the channel runtime of a deployment from its environment, or nothing where external channels do not exist.
 *
 * The runtime exists exactly where the mail domain variable is set. Whether it admits or delivers anything is then decided
 * by the kill switch, which is engaged unless the deployment releases it, and by the per-organization switch. The
 * correlator secret is read once from its SSM SecureString.
 *
 * @param environment The environment variables.
 * @param clients The AWS clients.
 * @param messagingTableName The Messaging table.
 * @returns The runtime, or null where the mail domain is not set.
 * @throws Error If the mail domain is set and another required variable or the parameter is missing or empty.
 */
export async function composeChannelsRuntime(
	environment: Record<string, string | undefined>,
	clients: ChannelsAwsClients,
	messagingTableName: string,
): Promise<ChannelsRuntime | null> {
	const mailDomain = environment[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? "";
	if (mailDomain === "") return null;
	const secretParameterName = named(environment, CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME_VARIABLE);
	const eventBusName = named(environment, CHANNELS_EVENT_BUS_NAME_VARIABLE);
	const response = await clients.parameters.send(new GetParameterCommand({ Name: secretParameterName, WithDecryption: true }));
	const correlatorSecret = response.Parameter?.Value ?? "";
	if (correlatorSecret === "") throw new Error(`The SSM parameter ${secretParameterName} has no value.`);
	const metrics = LOGGING_CHANNEL_METRICS;
	const email: ChannelTransport = new EmailChannelTransport({ mailDomain, metrics });
	return {
		store: new DynamoChannelStore(clients.dynamo, messagingTableName),
		mailDomain,
		allowedProviders: ["email"] satisfies TransportProvider[],
		killSwitchEngaged: killSwitchEngagedIn(environment),
		transports: new Map<TransportProvider, ChannelTransport>([["email", email]]),
		correlatorSecret,
		events: new EventBridgeChannelEventPublisher(eventsOf(clients), eventBusName),
		metrics,
	};
}

/**
 * Build what the turn executor needs to record the replies owed to external transports, or nothing where external
 * channels do not exist. The recorder is closed by the kill switch and by the organization switch on every reply, so an
 * organization that is not switched on records no delivery and publishes no event. The executor never reads the
 * correlator secret.
 *
 * @param environment The environment variables.
 * @param clients The AWS clients; the parameter reader is not used.
 * @param messagingTableName The Messaging table.
 * @param clock The clock.
 * @returns The recorder, or undefined where the mail domain is not set.
 * @throws Error If the mail domain is set and the bus name is missing.
 */
export function composeReplyDeliveryRecorder(
	environment: Record<string, string | undefined>,
	clients: Omit<ChannelsAwsClients, "parameters">,
	messagingTableName: string,
	clock: ReplyDeliveryRecorder["clock"],
): ReplyDeliveryRecorder | undefined {
	if ((environment[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? "") === "") return undefined;
	const eventBusName = named(environment, CHANNELS_EVENT_BUS_NAME_VARIABLE);
	return gatedReplyDeliveryRecorder(
		{ killSwitchEngaged: killSwitchEngagedIn(environment), store: new DynamoChannelStore(clients.dynamo, messagingTableName) },
		new EventBridgeChannelEventPublisher(eventsOf(clients), eventBusName),
		clock,
	);
}
