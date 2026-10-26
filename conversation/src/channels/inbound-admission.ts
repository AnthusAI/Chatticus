import type { MessageOrigin } from "../domain/channels.ts";
import { postMessage, type MessageDependencies } from "../domain/messages.ts";
import type { Clock, IdSource } from "../http/app.ts";
import { normalizedRouteKey } from "../store/channel-store.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { mapExternalConversation } from "./conversation-mapping.ts";
import type { ChannelMetricName } from "./metrics.ts";
import type { ChannelBinding } from "./records.ts";
import { externalChannelsAvailable, type ChannelsRuntime } from "./runtime.ts";
import type { ChannelTransport, InboundEvent, InboundRefusal, RawInbound, VerifiedInbound } from "./transport.ts";

/** How long a claimed inbound message may stay claimed before another delivery of it takes over. */
export const INBOUND_CLAIM_LEASE_SECONDS = 60;

/** Why an inbound event admitted nothing. */
export type DropReason =
	| "unknown_route"
	| "gate_closed"
	| "unlinked_sender"
	| "automated_message"
	| "in_flight"
	| "bot_not_in_conversation"
	| "sender_not_in_conversation";

/** What admitting one inbound event did. */
export type AdmissionOutcome =
	| { readonly kind: "admitted"; readonly channelId: string; readonly messageId: string; readonly turnId: string | null; readonly duplicate: boolean }
	| { readonly kind: "dropped"; readonly reason: DropReason };

/** Decides whether an automated message may start a turn; the full filter arrives with the abuse controls. */
export type AutomationFilter = (event: InboundEvent) => "allow" | "drop";

/**
 * The automation filter of milestone 1: a message the system itself sent, an auto-submitted message and a bounce report
 * are dropped, so a bot can never answer its own mail or another machine's. The full filter arrives with the abuse controls.
 */
export const dropAutomatedMessages: AutomationFilter = (event) =>
	event.automationHints.ownOrigin || event.automationHints.autoSubmitted || event.automationHints.bounceReport ? "drop" : "allow";

/** What admission reads and writes. */
export interface AdmissionDependencies {
	readonly runtime: ChannelsRuntime;
	readonly messaging: MessagingStore;
	readonly messages: MessageDependencies;
	readonly ids: IdSource;
	readonly clock: Clock;
	readonly automation: AutomationFilter;
}

const dropped = (runtime: ChannelsRuntime, reason: DropReason, counter: ChannelMetricName, dimensions: Record<string, string> = {}): AdmissionOutcome => {
	runtime.metrics.count(counter, { reason, ...dimensions });
	return { kind: "dropped", reason };
};

async function gateIsOpen(deps: AdmissionDependencies, binding: ChannelBinding): Promise<boolean> {
	if (!(await externalChannelsAvailable(deps.runtime, binding.tenantId))) return false;
	if (!binding.enabled) return false;
	const organization = await deps.messaging.getOrganization(binding.tenantId);
	if (organization === null || organization.status !== "enabled") return false;
	return (await deps.messaging.getBot(binding.tenantId, binding.botId)) !== null;
}

async function readerBotIds(deps: AdmissionDependencies, event: InboundEvent, binding: ChannelBinding): Promise<string[]> {
	const botIds: string[] = [];
	for (const routeKey of [...event.addressing.to, ...event.addressing.cc]) {
		const normalized = normalizedRouteKey(routeKey);
		if (normalized === binding.routeKey) continue;
		const target = await deps.runtime.store.resolveRoute(event.provider, normalized);
		if (target === null || target.tenantId !== binding.tenantId) continue;
		const readerBinding = await deps.runtime.store.getBinding(target.tenantId, target.bindingId);
		if (readerBinding === null || !readerBinding.enabled || botIds.includes(readerBinding.botId) || readerBinding.botId === binding.botId) continue;
		botIds.push(readerBinding.botId);
	}
	return botIds;
}

/**
 * Admit one provider-neutral inbound event. This is the only code that turns external input into a message.
 *
 * The steps are deterministic code: route, gates, the automation filter, sender resolution, deduplication, conversation
 * mapping, and then the existing message admission, which steers or starts the addressed bot's turn unchanged. An event
 * for an unknown route stores nothing and is only counted.
 *
 * @param deps The runtime, stores and message admission.
 * @param transport The transport the event arrived on.
 * @param event The event.
 * @returns What was admitted, or why nothing was.
 */
export async function admitInbound(deps: AdmissionDependencies, transport: ChannelTransport, event: InboundEvent): Promise<AdmissionOutcome> {
	const { runtime } = deps;
	runtime.metrics.count("inbound_received", { provider: event.provider });
	const routeKey = normalizedRouteKey(event.bindingRouteKey);
	const target = await runtime.store.resolveRoute(event.provider, routeKey);
	if (target === null) return dropped(runtime, "unknown_route", "inbound_unknown_route");
	const binding = await runtime.store.getBinding(target.tenantId, target.bindingId);
	if (binding === null) return dropped(runtime, "unknown_route", "inbound_unknown_route");
	if (!(await gateIsOpen(deps, binding))) return dropped(runtime, "gate_closed", "inbound_gate_closed", { provider: event.provider });
	if (deps.automation(event) === "drop") return dropped(runtime, "automated_message", "inbound_automated_dropped", { provider: event.provider });

	const link = await runtime.store.getIdentityLink(binding.tenantId, event.provider, event.sender.externalId.trim().toLowerCase());
	const membership = link === null ? null : await deps.messaging.getMembership(binding.tenantId, link.userId);
	if (link === null || membership === null) return dropped(runtime, "unlinked_sender", "inbound_unlinked_sender", { provider: event.provider });

	const claim = await runtime.store.claimInbound(binding.tenantId, binding.bindingId, event.externalMessageId, deps.clock.now(), INBOUND_CLAIM_LEASE_SECONDS);
	if (claim.kind === "in_flight") return dropped(runtime, "in_flight", "inbound_duplicate");
	if (claim.kind === "done") {
		runtime.metrics.count("inbound_duplicate", { provider: event.provider });
		return { kind: "admitted", channelId: claim.record.channelId ?? "", messageId: claim.record.messageId ?? "", turnId: claim.record.turnId, duplicate: true };
	}

	const botIds = [binding.botId, ...(await readerBotIds(deps, event, binding))];
	const channel = await mapExternalConversation(
		{ store: runtime.store, messaging: deps.messaging, ids: deps.ids, correlatorSecret: runtime.correlatorSecret },
		transport,
		event,
		binding,
		{ userId: link.userId },
		botIds,
	);
	if (channel === null) return dropped(runtime, "bot_not_in_conversation", "inbound_bot_not_in_conversation", { provider: event.provider });
	if (!channel.participants.some((participant) => participant.kind === "human" && participant.actorId === link.userId)) {
		return dropped(runtime, "sender_not_in_conversation", "inbound_sender_not_in_conversation", { provider: event.provider });
	}

	const origin: MessageOrigin = {
		bindingId: binding.bindingId,
		provider: event.provider,
		externalMessageId: event.externalMessageId,
		conversationKey: event.conversationKey,
		senderExternalId: event.sender.externalId.trim().toLowerCase(),
		assertion: event.sender.assertion,
	};
	const posted = await postMessage(deps.messages, {
		tenantId: binding.tenantId,
		channelId: channel.channelId,
		authorKind: "human",
		authorId: link.userId,
		body: event.text,
		addressedToBotId: binding.botId,
		idempotencyKey: `external:${binding.bindingId}:${event.externalMessageId}`,
		origin,
	});
	await runtime.store.putMessageChannel(binding.tenantId, binding.bindingId, event.externalMessageId, channel.channelId);
	await runtime.store.completeInbound(binding.tenantId, binding.bindingId, event.externalMessageId, {
		channelId: channel.channelId,
		messageId: posted.message.messageId,
		turnId: posted.turnId,
	});
	runtime.metrics.count("inbound_admitted", { provider: event.provider });
	return { kind: "admitted", channelId: channel.channelId, messageId: posted.message.messageId, turnId: posted.turnId, duplicate: false };
}

/** What one raw provider request produced. */
export type IngestResult =
	| { readonly kind: "refused"; readonly refusal: InboundRefusal }
	| { readonly kind: "processed"; readonly outcomes: AdmissionOutcome[] };

/**
 * Verify a raw provider request, normalize it into events and admit each one. A refused request admits nothing.
 *
 * @param deps The admission dependencies.
 * @param transport The transport that owns the request.
 * @param raw The request exactly as received.
 * @returns The refusal, or one outcome per event.
 */
export async function ingestInbound(deps: AdmissionDependencies, transport: ChannelTransport, raw: RawInbound): Promise<IngestResult> {
	const verified: VerifiedInbound | InboundRefusal = await transport.verifyInbound(raw);
	if (verified.kind === "refused") {
		deps.runtime.metrics.count("inbound_refused", { provider: raw.provider, reason: verified.reason });
		return { kind: "refused", refusal: verified };
	}
	const outcomes: AdmissionOutcome[] = [];
	for (const event of transport.normalize(verified)) {
		outcomes.push(await admitInbound(deps, transport, event));
	}
	return { kind: "processed", outcomes };
}
