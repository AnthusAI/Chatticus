import { PutEventsCommand, type PutEventsCommandOutput } from "@aws-sdk/client-eventbridge";
import type { ReplyDeliveryRecorder } from "./delivery.ts";
import type { ChannelEvent, ChannelEventPublisher } from "./events.ts";
import type { ChannelStore } from "./records.ts";
import { externalChannelsAvailable, type ChannelsRuntime } from "./runtime.ts";

/** The event source of every channel event; a rule on the bus matches on it together with the detail type. */
export const CHANNEL_EVENT_SOURCE = "chatticus.channels";

/** The part of an EventBridge client the publisher uses; a real client or a fake satisfies it. */
export interface EventPutter {
	send(command: PutEventsCommand): Promise<Pick<PutEventsCommandOutput, "FailedEntryCount" | "Entries">>;
}

/** Raised when the bus refuses a channel event; it names the detail type and the bus, never the detail. */
export class ChannelEventPublishError extends Error {
	constructor(detailType: string, eventBusName: string, reason: string) {
		super(`The event bus ${eventBusName} refused a ${detailType} event: ${reason}.`);
		this.name = "ChannelEventPublishError";
	}
}

/** Publishes channel events to one EventBridge bus as one entry each, with the ids-only detail as JSON. */
export class EventBridgeChannelEventPublisher implements ChannelEventPublisher {
	private readonly client: EventPutter;
	private readonly eventBusName: string;

	/**
	 * @param client The EventBridge client.
	 * @param eventBusName The name of the bus the delivery rule listens on.
	 */
	constructor(client: EventPutter, eventBusName: string) {
		this.client = client;
		this.eventBusName = eventBusName;
	}

	async publish(event: ChannelEvent): Promise<void> {
		const response = await this.client.send(
			new PutEventsCommand({
				Entries: [
					{
						EventBusName: this.eventBusName,
						Source: CHANNEL_EVENT_SOURCE,
						DetailType: event.detailType,
						Detail: JSON.stringify(event.detail),
					},
				],
			}),
		);
		if ((response.FailedEntryCount ?? 0) > 0) {
			throw new ChannelEventPublishError(event.detailType, this.eventBusName, response.Entries?.[0]?.ErrorCode ?? "unknown_error");
		}
	}
}

/** What the turn executor needs to decide, per organization, whether a reply is owed to an external transport. */
export type ReplyDeliveryGate = Pick<ChannelsRuntime, "killSwitchEngaged"> & { readonly store: Pick<ChannelStore, "getSettings" | "putDeliveryIfAbsent"> };

/**
 * The reply recorder of the turn executor, closed by the same two switches as everything else: while the environment kill
 * switch is engaged, or while the organization is not switched on, a reply records no delivery and publishes no event.
 *
 * @param gate The kill switch and the channel store.
 * @param events The publisher of the bus.
 * @param clock The clock.
 * @returns The recorder the executor's finalization uses.
 */
export function gatedReplyDeliveryRecorder(gate: ReplyDeliveryGate, events: ChannelEventPublisher, clock: ReplyDeliveryRecorder["clock"]): ReplyDeliveryRecorder {
	const open = (tenantId: string): Promise<boolean> => externalChannelsAvailable(gate, tenantId);
	return {
		clock,
		store: {
			putDeliveryIfAbsent: async (delivery) => ((await open(delivery.tenantId)) ? gate.store.putDeliveryIfAbsent(delivery) : false),
		},
		events: {
			publish: async (event) => {
				if (await open(event.detail.tenant_id)) await events.publish(event);
			},
		},
	};
}
