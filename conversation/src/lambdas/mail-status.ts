import type { SnsEvent } from "../channels/email/mail-status-handler.ts";
import { composeMailStatusHandler, defaultMailAwsClients, lazyHandler } from "./mail-composition.ts";

const handleStatus = lazyHandler<SnsEvent, void>(() => composeMailStatusHandler(process.env, defaultMailAwsClients()));

/**
 * Entry point of the status function, subscribed to the SNS topic of the SES configuration set. It believes a notification
 * only after verifying the SNS signature for the configured topic.
 *
 * @param event The SNS event.
 */
export async function handler(event: SnsEvent): Promise<void> {
	await handleStatus(event);
}
