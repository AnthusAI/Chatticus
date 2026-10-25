import assert from "node:assert/strict";
import { ScanCommand } from "@aws-sdk/client-dynamodb";
import type { ChannelEvent, ChannelEventPublisher } from "../src/channels/events.ts";
import type { AdmissionDependencies, AdmissionOutcome } from "../src/channels/inbound-admission.ts";
import { allowEveryMessage } from "../src/channels/inbound-admission.ts";
import type { DeliveryDependencies, SweepDependencies } from "../src/channels/delivery.ts";
import { FakeChannelTransport } from "../src/channels/fake-transport.ts";
import type { ChannelMetricName, ChannelMetrics } from "../src/channels/metrics.ts";
import type { ChannelsRuntime } from "../src/channels/runtime.ts";
import type { ReplyDeliveryRecorder } from "../src/channels/delivery.ts";
import type { InboundRefusal, RawInbound, TransportProvider } from "../src/channels/transport.ts";
import { listMessages } from "../src/domain/messages.ts";
import { DynamoChannelStore } from "../src/store/channel-store.ts";
import type { RecordedResponse } from "./api.ts";
import { executorMessageDependencies } from "./front-door.ts";
import type { ChatticusWorld } from "./world.ts";

/** One counter increment the scenario's metrics recorded. */
export type CountedMetric = { readonly name: ChannelMetricName; readonly dimensions: Readonly<Record<string, string>> };

/** Everything the external channel features keep for the length of one scenario. */
export type ChannelsScenario = {
	configured: boolean;
	killSwitchEngaged: boolean;
	mailDomain: string;
	readonly fake: FakeChannelTransport;
	readonly published: ChannelEvent[];
	readonly counted: CountedMetric[];
	response: RecordedResponse | null;
	operatorResponse: RecordedResponse | null;
	lastRequest: RawInbound | null;
	readonly outcomes: AdmissionOutcome[];
	lastRefusal: InboundRefusal | null;
	countedItems: number | null;
	focusChannel: { channelId: string; tenantId: string; person: string } | null;
	deliveriesResponse: RecordedResponse | null;
};

const scenarios = new WeakMap<ChatticusWorld, ChannelsScenario>();

/** The channel features' state for this scenario, created on first use. */
export function channelsScenarioOf(world: ChatticusWorld): ChannelsScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			configured: false,
			killSwitchEngaged: false,
			mailDomain: "mail.scenario.invalid",
			fake: new FakeChannelTransport(),
			published: [],
			counted: [],
			response: null,
			operatorResponse: null,
			lastRequest: null,
			outcomes: [],
			lastRefusal: null,
			countedItems: null,
			focusChannel: null,
			deliveriesResponse: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The channel runtime of the scenario when external channels are configured, otherwise undefined. */
export function channelsRuntimeFor(world: ChatticusWorld): ChannelsRuntime | undefined {
	const scenario = channelsScenarioOf(world);
	if (!scenario.configured) return undefined;
	const events: ChannelEventPublisher = { publish: async (event) => void scenario.published.push(event) };
	const metrics: ChannelMetrics = { count: (name, dimensions = {}) => void scenario.counted.push({ name, dimensions }) };
	return {
		store: new DynamoChannelStore(world.messagingTable.client, world.messagingTable.tableName),
		mailDomain: scenario.mailDomain,
		allowedProviders: ["email", "fake"] satisfies TransportProvider[],
		killSwitchEngaged: scenario.killSwitchEngaged,
		transports: new Map([["fake", scenario.fake]]),
		events,
		metrics,
	};
}

/** The runtime of a scenario that must have external channels configured. */
export function requiredChannelsRuntime(world: ChatticusWorld): ChannelsRuntime {
	const runtime = channelsRuntimeFor(world);
	assert.ok(runtime, "External channels are not configured in this scenario");
	return runtime;
}

/** What the turn executor needs to record the replies owed to external transports. */
export function channelDeliveryFor(world: ChatticusWorld): ReplyDeliveryRecorder | undefined {
	const runtime = channelsRuntimeFor(world);
	return runtime === undefined ? undefined : { store: runtime.store, events: runtime.events, clock: world.clock };
}

/** The dependencies of the inbound admission path over the scenario's stores. */
export async function admissionDependenciesFor(world: ChatticusWorld): Promise<AdmissionDependencies> {
	return {
		runtime: requiredChannelsRuntime(world),
		messaging: world.messagingStore(),
		messages: await executorMessageDependencies(world),
		ids: world.ids,
		clock: world.clock,
		automation: allowEveryMessage,
	};
}

/** The dependencies of the delivery handler and the sweeper over the scenario's stores. */
export async function deliveryDependenciesFor(world: ChatticusWorld): Promise<SweepDependencies & DeliveryDependencies> {
	const messages = await executorMessageDependencies(world);
	return {
		runtime: requiredChannelsRuntime(world),
		clock: world.clock,
		messaging: world.messagingStore(),
		loadMessage: async (tenantId, channelId, seq) => {
			const listed = await listMessages(messages, { tenantId, channelId, afterSeq: seq - 1 });
			const found = listed.find((message) => message.seq === seq);
			return found === undefined
				? null
				: { messageId: found.messageId, channelId: found.channelId, tenantId: found.tenantId, seq: found.seq, body: found.body, createdAt: found.createdAt };
		},
	};
}

/** How many items the scenario's Messaging table holds right now. */
export async function messagingItemCount(world: ChatticusWorld): Promise<number> {
	let total = 0;
	let exclusiveStartKey: Record<string, any> | undefined;
	do {
		const page = await world.messagingTable.client.send(
			new ScanCommand({ TableName: world.messagingTable.tableName, Select: "COUNT", ExclusiveStartKey: exclusiveStartKey }),
		);
		total += page.Count ?? 0;
		exclusiveStartKey = page.LastEvaluatedKey;
	} while (exclusiveStartKey !== undefined);
	return total;
}
