import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { ReplyDeliveryRecorder } from "../channels/delivery.ts";
import { EmailChannelTransport } from "../channels/email/email-transport.ts";
import { EventBridgeChannelEventPublisher, gatedReplyDeliveryRecorder, type EventPutter } from "../channels/eventbridge-publisher.ts";
import type { ChannelMetrics } from "../channels/metrics.ts";
import type { ChannelsRuntime, ChannelsRuntimeSource } from "../channels/runtime.ts";
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

/** Where structured log lines go; the deployed Lambdas pass `console.log`. */
export type StructuredLog = (line: string) => void;

/** Counts channel events as one structured log line each: the name and its dimensions, never a message text or an address. */
export function loggingChannelMetrics(log: StructuredLog = console.log): ChannelMetrics {
	return { count: (name, dimensions = {}) => log(JSON.stringify({ component: "channels", metric: name, ...dimensions })) };
}

function failureLine(event: string, error: unknown): string {
	return JSON.stringify({
		component: "channels",
		level: "error",
		event,
		error_name: error instanceof Error ? error.name : "UnknownError",
		detail: error instanceof Error ? error.message : "unknown",
	});
}

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
 * @param log Where the metrics lines go.
 * @returns The runtime, or null where the mail domain is not set.
 * @throws Error If the mail domain is set and another required variable or the parameter is missing or empty.
 */
export async function composeChannelsRuntime(
	environment: Record<string, string | undefined>,
	clients: ChannelsAwsClients,
	messagingTableName: string,
	log: StructuredLog = console.log,
): Promise<ChannelsRuntime | null> {
	const mailDomain = environment[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? "";
	if (mailDomain === "") return null;
	const secretParameterName = named(environment, CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME_VARIABLE);
	const eventBusName = named(environment, CHANNELS_EVENT_BUS_NAME_VARIABLE);
	const response = await clients.parameters.send(new GetParameterCommand({ Name: secretParameterName, WithDecryption: true }));
	const correlatorSecret = response.Parameter?.Value ?? "";
	if (correlatorSecret === "") throw new Error(`The SSM parameter ${secretParameterName} has no value.`);
	const metrics = loggingChannelMetrics(log);
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
 * @param log Where a failed publish is reported, with names and ids only.
 * @returns The recorder, or undefined where the mail domain is not set.
 * @throws Error If the mail domain is set and the bus name is missing.
 */
export function composeReplyDeliveryRecorder(
	environment: Record<string, string | undefined>,
	clients: Omit<ChannelsAwsClients, "parameters">,
	messagingTableName: string,
	clock: ReplyDeliveryRecorder["clock"],
	log: StructuredLog = console.log,
): ReplyDeliveryRecorder | undefined {
	if ((environment[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? "") === "") return undefined;
	const eventBusName = named(environment, CHANNELS_EVENT_BUS_NAME_VARIABLE);
	return gatedReplyDeliveryRecorder(
		{ killSwitchEngaged: killSwitchEngagedIn(environment), store: new DynamoChannelStore(clients.dynamo, messagingTableName) },
		new EventBridgeChannelEventPublisher(eventsOf(clients), eventBusName),
		clock,
		(failure) =>
			log(
				JSON.stringify({
					component: "channels",
					level: "error",
					event: "channel_event_publish_failed",
					tenant_id: failure.tenantId,
					message_id: failure.messageId,
					binding_id: failure.bindingId,
					error_name: failure.errorName,
				}),
			),
	);
}

/**
 * The recorder for one executor invocation, confined so that a bad channel setting never fails an ordinary turn: when
 * composition throws, one structured error is logged and the invocation runs without a recorder.
 *
 * @param environment The environment variables.
 * @param clients The AWS clients.
 * @param messagingTableName The Messaging table.
 * @param clock The clock.
 * @param log Where lines go.
 * @returns The recorder, or undefined where channels do not exist or their setting is broken.
 */
export function replyDeliveryRecorderOrNothing(
	environment: Record<string, string | undefined>,
	clients: Omit<ChannelsAwsClients, "parameters">,
	messagingTableName: string,
	clock: ReplyDeliveryRecorder["clock"],
	log: StructuredLog = console.log,
): ReplyDeliveryRecorder | undefined {
	try {
		return composeReplyDeliveryRecorder(environment, clients, messagingTableName, clock, log);
	} catch (error) {
		log(failureLine("channels_composition_failed", error));
		return undefined;
	}
}

/** How long a failed channel composition waits before the next request tries again. */
export const CHANNELS_COMPOSITION_RETRY_SECONDS = 60;

/**
 * Holds the channel runtime of a front door and keeps a failure to build it away from every other path. A successful
 * build, or the answer that channels do not exist here, is kept for the life of the process. A failed build logs one
 * structured error, makes channel requests see nothing, and is tried again by the first channel request after
 * {@link CHANNELS_COMPOSITION_RETRY_SECONDS}, so a transient parameter read error heals without a redeploy.
 */
export class ChannelsRuntimeHolder {
	private settled = false;
	private runtime: ChannelsRuntime | null = null;
	private nextAttemptAt = 0;
	private attempt: Promise<void> | null = null;
	private readonly compose: () => Promise<ChannelsRuntime | null>;
	private readonly clock: { now(): Date };
	private readonly log: StructuredLog;

	/**
	 * @param compose Builds the runtime; may throw.
	 * @param clock The clock that spaces the retries.
	 * @param log Where the failure line goes.
	 */
	constructor(compose: () => Promise<ChannelsRuntime | null>, clock: { now(): Date }, log: StructuredLog = console.log) {
		this.compose = compose;
		this.clock = clock;
		this.log = log;
	}

	/** The runtime built so far, or null. */
	get current(): ChannelsRuntime | null {
		return this.runtime;
	}

	/** The source the HTTP application asks on every channel request. */
	readonly source: ChannelsRuntimeSource = async () => {
		if (this.settled) return this.runtime;
		if (this.clock.now().getTime() < this.nextAttemptAt) return null;
		this.attempt ??= this.tryCompose().finally(() => {
			this.attempt = null;
		});
		await this.attempt;
		return this.runtime;
	};

	private async tryCompose(): Promise<void> {
		try {
			this.runtime = await this.compose();
			this.settled = true;
		} catch (error) {
			this.log(failureLine("channels_composition_failed", error));
			this.nextAttemptAt = this.clock.now().getTime() + CHANNELS_COMPOSITION_RETRY_SECONDS * 1000;
		}
	}
}
