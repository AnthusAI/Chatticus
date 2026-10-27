import type { ChannelMessageCreatedBusEvent, DeliveryInvocationResult } from "../channels/email/mail-delivery-handler.ts";
import { composeMailDeliveryHandler, defaultMailAwsClients, lazyHandler } from "./mail-composition.ts";

const handleCreated = lazyHandler<ChannelMessageCreatedBusEvent, DeliveryInvocationResult>(() => composeMailDeliveryHandler(process.env, defaultMailAwsClients()));

/**
 * Entry point of the delivery function, invoked by the event bus rule for the channel.message.created event. It sends the
 * reply through SES and fails, so that the platform retries, when the send may succeed later.
 *
 * @param event The bus event.
 * @returns What the invocation did.
 */
export async function handler(event: ChannelMessageCreatedBusEvent): Promise<DeliveryInvocationResult> {
	return handleCreated(event);
}
