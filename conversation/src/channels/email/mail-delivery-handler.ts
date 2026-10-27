import { deliverChannelMessage, type DeliveryDependencies } from "../delivery.ts";
import { CHANNEL_EVENT_SOURCE } from "../eventbridge-publisher.ts";
import { CHANNEL_MESSAGE_CREATED } from "../events.ts";

/** The part of an EventBridge event the delivery function reads. */
export interface ChannelMessageCreatedBusEvent {
	readonly source?: unknown;
	readonly "detail-type"?: unknown;
	readonly detail?: { readonly tenant_id?: unknown; readonly message_id?: unknown; readonly binding_id?: unknown };
}

/** Raised when a send may succeed later, so the platform retries the invocation. */
export class RetryableDeliveryError extends Error {
	readonly reasonCode: string;

	constructor(reasonCode: string) {
		super(`The reply could not be sent yet (${reasonCode}); the platform retries.`);
		this.name = "RetryableDeliveryError";
		this.reasonCode = reasonCode;
	}
}

/** What one invocation did. */
export type DeliveryInvocationResult = "ignored" | "unknown_delivery" | "settled";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Handle the announcement that a reply is owed to an external transport: send it through the existing delivery path. An
 * event that is not that announcement, or lacks an id, is ignored; a reply already sent or settled sends nothing; a
 * delivery left retryable fails the invocation so the platform's own retry runs it again.
 *
 * @param deps The runtime, with the email transport registered, the clock, the messaging store and the message loader.
 * @param event The bus event.
 * @returns What the invocation did.
 * @throws RetryableDeliveryError When SES asked for the send to be tried again.
 */
export async function handleChannelMessageCreated(deps: DeliveryDependencies, event: ChannelMessageCreatedBusEvent): Promise<DeliveryInvocationResult> {
	const detail = event.detail;
	if (event.source !== CHANNEL_EVENT_SOURCE || event["detail-type"] !== CHANNEL_MESSAGE_CREATED) return "ignored";
	if (!nonEmpty(detail?.tenant_id) || !nonEmpty(detail.message_id) || !nonEmpty(detail.binding_id)) return "ignored";
	const delivery = await deliverChannelMessage(deps, { tenantId: detail.tenant_id, messageId: detail.message_id, bindingId: detail.binding_id });
	if (delivery === null) return "unknown_delivery";
	if (delivery.state === "retryable") throw new RetryableDeliveryError(delivery.reasonCode ?? "retryable");
	return "settled";
}
