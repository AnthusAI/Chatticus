import type { MessageOrigin } from "../domain/channels.ts";
import type { Clock } from "../http/app.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { channelMessageCreatedEvent, type ChannelEventPublisher } from "./events.ts";
import type { ChannelLogLine } from "../pi/channel-log.ts";
import type { ChannelStore, DeliveryRecord, DeliveryState } from "./records.ts";
import { externalChannelsAvailable, type ChannelsRuntime } from "./runtime.ts";
import {
	TransportDeliveryError,
	type ChannelTransport,
	type CommittedMessage,
	type DeliveryFailureClass,
	type DeliveryStatusEvent,
	type RawInbound,
} from "./transport.ts";

/** How many times the sweeper retries a reply before it gives up and records the failure. */
export const MAXIMUM_DELIVERY_ATTEMPTS = 5;

/** How long a reply may stay pending or retryable before the sweeper looks at it. */
export const STALE_DELIVERY_SECONDS = 180;

/** What a turn's completion needs to record that a reply is owed. */
export interface ReplyDeliveryRecorder {
	readonly store: Pick<ChannelStore, "putDeliveryIfAbsent">;
	readonly events: ChannelEventPublisher;
	readonly clock: Clock;
	/** Called, with names and ids only, when the event could not be published after the delivery was recorded. */
	readonly reportPublishFailure: (failure: { tenantId: string; messageId: string; bindingId: string; errorName: string }) => void;
}

/**
 * Where a turn's reply is owed, from the channel log lines of the turn. A turn the web app started is owed nowhere. A
 * turn an external message started is owed to the origin of the most recent external message the turn took in, so a
 * steered turn answers the last thing it was told.
 *
 * @param lines The channel log lines of the channel.
 * @param turn The turn: its prompt sequence and its bot.
 * @param replySeq The sequence the reply is committed at.
 * @returns The origin the reply follows, or null when the reply is not owed to an external transport.
 */
export function replyOriginOf(lines: readonly ChannelLogLine[], turn: { promptMessageSeq: number | null; botId: string }, replySeq: number): MessageOrigin | null {
	if (turn.promptMessageSeq === null) return null;
	const promptSeq = turn.promptMessageSeq;
	const prompt = lines.find((line) => line.seq === promptSeq);
	if (prompt?.origin === undefined) return null;
	const inputs = lines
		.filter((line) => line.authorKind !== "bot" && line.addressedToBotId === turn.botId && line.seq >= promptSeq && line.seq < replySeq && line.origin !== undefined)
		.sort((left, right) => right.seq - left.seq);
	return inputs[0]?.origin ?? prompt.origin;
}

/**
 * Record that a committed reply is owed to an external transport and tell the delivery handler, with ids only. A failure to
 * tell the handler is reported and does not fail the caller: the delivery is already recorded, and the sweeper finds it.
 * Doing it
 * again for the same reply records nothing new and tells the handler again, which is harmless: the handler is idempotent.
 *
 * @param recorder The delivery store, the event publisher and the clock.
 * @param reply The committed reply.
 * @param origin The origin the reply follows.
 */
export async function recordReplyDelivery(
	recorder: ReplyDeliveryRecorder,
	reply: { tenantId: string; channelId: string; messageId: string; messageSeq: number },
	origin: MessageOrigin,
): Promise<void> {
	const now = recorder.clock.now();
	await recorder.store.putDeliveryIfAbsent({
		tenantId: reply.tenantId,
		messageId: reply.messageId,
		bindingId: origin.bindingId,
		channelId: reply.channelId,
		messageSeq: reply.messageSeq,
		conversationKey: origin.conversationKey,
		recipientExternalId: origin.senderExternalId,
		inReplyToExternalMessageId: origin.externalMessageId,
		state: "pending",
		attempts: 0,
		failureClass: null,
		reasonCode: null,
		providerMessageId: null,
		createdAt: now,
		updatedAt: now,
	});
	try {
		await recorder.events.publish(channelMessageCreatedEvent({ tenantId: reply.tenantId, messageId: reply.messageId, bindingId: origin.bindingId }));
	} catch (error) {
		recorder.reportPublishFailure({
			tenantId: reply.tenantId,
			messageId: reply.messageId,
			bindingId: origin.bindingId,
			errorName: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

/** What the delivery handler reads and writes. */
export interface DeliveryDependencies {
	readonly runtime: ChannelsRuntime;
	readonly clock: Clock;
	/** The messaging store that tells whether the organization is enabled. */
	readonly messaging: MessagingStore;
	/** The committed message at a sequence of a channel, or null when there is none. */
	readonly loadMessage: (tenantId: string, channelId: string, seq: number) => Promise<CommittedMessage | null>;
}

const settled = (delivery: DeliveryRecord, state: DeliveryState, at: Date, change: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
	...delivery,
	state,
	updatedAt: at,
	...change,
});

async function fail(deps: DeliveryDependencies, delivery: DeliveryRecord, failureClass: DeliveryFailureClass, reasonCode: string): Promise<DeliveryRecord> {
	const next = settled(delivery, "failed", deps.clock.now(), { failureClass, reasonCode });
	await deps.runtime.store.putDelivery(next);
	deps.runtime.metrics.count("outbound_failed", { failure_class: failureClass });
	return next;
}

/**
 * Deliver one owed reply: load the message and the binding, refuse when the organization is not enabled, render, send with the idempotency key message id plus binding
 * id, and record the result. A reply already sent, failed or settled is left alone, so a repeated event sends nothing.
 *
 * @param deps The runtime, clock and message loader.
 * @param ids The ids the event carried.
 * @returns The delivery after the attempt, or null when no such delivery exists.
 */
export async function deliverChannelMessage(deps: DeliveryDependencies, ids: { tenantId: string; messageId: string; bindingId: string }): Promise<DeliveryRecord | null> {
	const { store } = deps.runtime;
	const delivery = await store.getDelivery(ids.tenantId, ids.messageId, ids.bindingId);
	if (delivery === null) return null;
	if (delivery.state !== "pending" && delivery.state !== "retryable") return delivery;
	const binding = await store.getBinding(delivery.tenantId, delivery.bindingId);
	if (binding === null || !binding.enabled) return fail(deps, delivery, "suppressed", "binding_disabled");
	if (!(await externalChannelsAvailable(deps.runtime, delivery.tenantId))) return fail(deps, delivery, "suppressed", "external_channels_off");
	const organization = await deps.messaging.getOrganization(delivery.tenantId);
	if (organization === null || organization.status !== "enabled") return fail(deps, delivery, "suppressed", "organization_suspended");
	const transport: ChannelTransport | undefined = deps.runtime.transports.get(binding.provider);
	if (transport === undefined) return fail(deps, delivery, "permanent", "no_transport");
	const message = await deps.loadMessage(delivery.tenantId, delivery.channelId, delivery.messageSeq);
	if (message === null) return fail(deps, delivery, "permanent", "message_missing");
	const transportBinding = { bindingId: binding.bindingId, tenantId: binding.tenantId, provider: binding.provider, routeKey: binding.routeKey };
	const channel = await deps.messaging.getChannel(delivery.tenantId, delivery.channelId);
	const payload = transport.render(message, transportBinding, {
		conversationKey: delivery.conversationKey,
		recipientExternalId: delivery.recipientExternalId,
		inReplyToExternalMessageId: delivery.inReplyToExternalMessageId,
		subject: channel?.name ?? null,
	});
	const attempts = delivery.attempts + 1;
	try {
		const receipt = await transport.deliver(payload, transportBinding, `${delivery.messageId}:${delivery.bindingId}`);
		const sent = settled(delivery, "sent", deps.clock.now(), { attempts, providerMessageId: receipt.providerMessageId, failureClass: null, reasonCode: null });
		await store.putDelivery(sent);
		await store.putProviderMessageIndex(binding.provider, receipt.providerMessageId, { tenantId: delivery.tenantId, messageId: delivery.messageId, bindingId: delivery.bindingId });
		await store.putMessageChannel(delivery.tenantId, delivery.bindingId, receipt.externalMessageId, delivery.channelId);
		deps.runtime.metrics.count("outbound_sent", { provider: binding.provider });
		return sent;
	} catch (error) {
		const failure = error instanceof TransportDeliveryError ? error : new TransportDeliveryError("retryable", "transport_error");
		if (failure.failureClass === "retryable") {
			const retry = settled(delivery, "retryable", deps.clock.now(), { attempts, failureClass: "retryable", reasonCode: failure.reasonCode });
			await store.putDelivery(retry);
			deps.runtime.metrics.count("outbound_failed", { failure_class: "retryable" });
			return retry;
		}
		return fail(deps, { ...delivery, attempts }, failure.failureClass, failure.reasonCode);
	}
}

/** What the sweeper reads. */
export type SweepDependencies = DeliveryDependencies;

/**
 * Retry the replies that stayed pending or retryable past the stale age, and give up on a reply that has been tried the
 * maximum number of times, recording the failure where the owner can read it. Run by a scheduler once per environment.
 *
 * @param deps The delivery dependencies and the messaging store that lists organizations.
 * @returns How many replies were retried and how many were given up on.
 */
export async function sweepStaleDeliveries(deps: SweepDependencies): Promise<{ retried: number; gaveUp: number }> {
	let retried = 0;
	let gaveUp = 0;
	const threshold = deps.clock.now().getTime() - STALE_DELIVERY_SECONDS * 1000;
	for (const organization of await deps.messaging.listOrganizationsByStatus("enabled")) {
		if (!(await externalChannelsAvailable(deps.runtime, organization.tenantId))) continue;
		for (const delivery of await deps.runtime.store.listOpenDeliveries(organization.tenantId)) {
			if (delivery.updatedAt.getTime() > threshold) continue;
			if (delivery.attempts >= MAXIMUM_DELIVERY_ATTEMPTS) {
				await fail(deps, delivery, "permanent", "retries_exhausted");
				deps.runtime.metrics.count("outbound_gave_up");
				gaveUp += 1;
				continue;
			}
			await deliverChannelMessage(deps, delivery);
			retried += 1;
		}
	}
	return { retried, gaveUp };
}

const STATE_OF_STATUS: Readonly<Record<DeliveryStatusEvent["status"], DeliveryState>> = {
	delivered: "delivered",
	bounced: "bounced",
	complained: "complained",
	opted_out: "failed",
};

/**
 * Apply one provider callback to the delivery it names: delivered, bounced, complained or opted out. A bounced or
 * complained delivery is final, so a late delivery notification cannot revert it. A callback for a message this system never
 * sent changes nothing.
 *
 * @param deps The runtime and clock.
 * @param event The status event.
 * @returns The delivery after the change, or null when none matches.
 */
export async function applyDeliveryStatus(deps: Pick<DeliveryDependencies, "runtime" | "clock">, event: DeliveryStatusEvent): Promise<DeliveryRecord | null> {
	const delivery = await deps.runtime.store.getDeliveryByProviderMessage(event.provider, event.providerMessageId);
	if (delivery === null) return null;
	if (delivery.state === "bounced" || delivery.state === "complained") return delivery;
	const optedOut = event.status === "opted_out";
	const next = settled(delivery, STATE_OF_STATUS[event.status], deps.clock.now(), {
		failureClass: optedOut ? "opted_out" : delivery.failureClass,
		reasonCode: event.reason ?? (event.status === "delivered" ? delivery.reasonCode : event.status),
	});
	await deps.runtime.store.putDelivery(next);
	return next;
}

/**
 * Turn a provider callback into status events with the transport and apply each one.
 *
 * @param deps The runtime and clock.
 * @param transport The transport that owns the callback.
 * @param raw The callback exactly as received.
 * @returns The deliveries that changed.
 */
export async function processStatusCallback(deps: Pick<DeliveryDependencies, "runtime" | "clock">, transport: ChannelTransport, raw: RawInbound): Promise<DeliveryRecord[]> {
	const changed: DeliveryRecord[] = [];
	for (const event of transport.parseStatus(raw)) {
		const delivery = await applyDeliveryStatus(deps, event);
		if (delivery !== null) changed.push(delivery);
	}
	return changed;
}
