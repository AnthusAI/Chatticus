import type { SesReceiptEvent } from "../channels/email/mail-ingress-handler.ts";
import { composeMailIngressHandler, defaultMailAwsClients, lazyHandler } from "./mail-composition.ts";

const handleReceipt = lazyHandler<SesReceiptEvent, void>(() => composeMailIngressHandler(process.env, defaultMailAwsClients()));

/**
 * Entry point of the mail ingress function, invoked asynchronously by the SES receipt rule after the raw message was stored.
 * It fails, so that the platform retries, while a message is claimed and unfinished or its archive object is missing.
 *
 * @param event The SES receipt event.
 */
export async function handler(event: SesReceiptEvent): Promise<void> {
	await handleReceipt(event);
}
