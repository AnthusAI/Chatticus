import type { DeliveryStatusEvent } from "../transport.ts";
import { normalizeEmailAddress } from "./email-addresses.ts";

/** One SES event as the delivery state machine and the suppression list need it. */
export interface SesStatusFact {
	readonly event: DeliveryStatusEvent;
	readonly suppressAddresses: readonly string[];
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null);

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function recipientAddresses(list: unknown): string[] {
	if (!Array.isArray(list)) return [];
	return list
		.map((entry) => asObject(entry)?.["emailAddress"])
		.filter((address): address is string => typeof address === "string")
		.map(normalizeEmailAddress)
		.filter((address) => address.includes("@"));
}

const reasonText = (value: unknown, fallback: string): string => (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value.toLowerCase() : fallback);

/**
 * Read one request an SES configuration set event destination delivered through SNS. The body is the SNS notification
 * whose Message is the SES event, or the SES event itself. Only events that move a delivery are returned: a delivery,
 * a permanent bounce, a complaint and a rejection. A send, a transient or undetermined bounce, a subscription
 * confirmation and anything unreadable return nothing.
 *
 * @param body The request body exactly as received.
 * @returns The facts, in order.
 */
export function sesStatusFacts(body: string): SesStatusFact[] {
	let parsed = asObject(parseJson(body));
	if (parsed !== null && parsed["Type"] === "Notification" && typeof parsed["Message"] === "string") parsed = asObject(parseJson(parsed["Message"]));
	if (parsed === null) return [];
	const providerMessageId = asObject(parsed["mail"])?.["messageId"];
	if (typeof providerMessageId !== "string" || providerMessageId === "") return [];
	const status = (value: DeliveryStatusEvent["status"], reason: string | null): DeliveryStatusEvent => ({ provider: "email", providerMessageId, status: value, reason });
	switch (parsed["eventType"]) {
		case "Delivery":
			return [{ event: status("delivered", null), suppressAddresses: [] }];
		case "Bounce": {
			const bounce = asObject(parsed["bounce"]);
			if (bounce?.["bounceType"] !== "Permanent") return [];
			return [{ event: status("bounced", `bounce_permanent_${reasonText(bounce["bounceSubType"], "general")}`), suppressAddresses: recipientAddresses(bounce["bouncedRecipients"]) }];
		}
		case "Complaint": {
			const complaint = asObject(parsed["complaint"]);
			return [{ event: status("complained", `complaint_${reasonText(complaint?.["complaintFeedbackType"], "unspecified")}`), suppressAddresses: recipientAddresses(complaint?.["complainedRecipients"]) }];
		}
		case "Reject":
			return [{ event: status("bounced", "ses_reject"), suppressAddresses: [] }];
		default:
			return [];
	}
}
