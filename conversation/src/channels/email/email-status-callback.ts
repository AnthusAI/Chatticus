import { applyDeliveryStatus, type DeliveryDependencies } from "../delivery.ts";
import type { DeliveryRecord } from "../records.ts";
import type { RawInbound } from "../transport.ts";
import { normalizeEmailAddress } from "./email-addresses.ts";
import type { EmailChannelTransport } from "./email-transport.ts";
import type { RecipientSuppressionList } from "./recipient-suppression.ts";

/**
 * Apply one SES notification: move each delivery it names to delivered, bounced or complained, and suppress the
 * recipient of a permanent bounce or a complaint for the binding that sent the mail. Only the address the reply was sent to
 * is ever suppressed: any other address a notification names is ignored, so a forged notification cannot suppress addresses
 * of its choosing. A notification for a message this system never sent changes nothing and suppresses nobody.
 *
 * The body is trusted as received. The ingress that calls this must first verify the SNS signature, the signing
 * certificate host and the topic ARN; without that check anyone who knows a message id can forge a bounce for it.
 *
 * @param deps The runtime and clock, and the suppression list the email transport checks before every send.
 * @param transport The email transport that reads the notification.
 * @param raw The notification exactly as the SNS subscription delivered it.
 * @returns The deliveries that changed.
 */
export async function applyEmailStatusCallback(
	deps: Pick<DeliveryDependencies, "runtime" | "clock"> & { readonly suppressionList: RecipientSuppressionList },
	transport: EmailChannelTransport,
	raw: RawInbound,
): Promise<DeliveryRecord[]> {
	const changed: DeliveryRecord[] = [];
	for (const fact of transport.statusFacts(raw)) {
		const delivery = await applyDeliveryStatus(deps, fact.event);
		if (delivery === null) continue;
		changed.push(delivery);
		const recipient = normalizeEmailAddress(delivery.recipientExternalId);
		for (const address of fact.suppressAddresses.map(normalizeEmailAddress).filter((candidate) => candidate === recipient)) {
			await deps.suppressionList.suppress({
				tenantId: delivery.tenantId,
				bindingId: delivery.bindingId,
				address,
				reason: fact.event.reason ?? fact.event.status,
				suppressedAt: deps.clock.now(),
			});
		}
	}
	return changed;
}
