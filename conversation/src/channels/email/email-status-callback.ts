import { applyDeliveryStatus, type DeliveryDependencies } from "../delivery.ts";
import type { DeliveryRecord } from "../records.ts";
import type { RawInbound } from "../transport.ts";
import { normalizeEmailAddress } from "./email-addresses.ts";
import type { EmailChannelTransport } from "./email-transport.ts";
import type { RecipientSuppressionList } from "./recipient-suppression.ts";

/**
 * Apply one SES notification: move each delivery it names to delivered, bounced or complained, and suppress the
 * recipients of a permanent bounce or a complaint for the binding that sent the mail. A notification for a message this
 * system never sent changes nothing and suppresses nobody.
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
		for (const address of fact.suppressAddresses) {
			await deps.suppressionList.suppress({
				tenantId: delivery.tenantId,
				bindingId: delivery.bindingId,
				address: normalizeEmailAddress(address),
				reason: fact.event.reason ?? fact.event.status,
				suppressedAt: deps.clock.now(),
			});
		}
	}
	return changed;
}
