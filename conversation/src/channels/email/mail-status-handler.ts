import type { Clock } from "../../http/app.ts";
import type { DeliveryDependencies } from "../delivery.ts";
import { applyEmailStatusCallback } from "./email-status-callback.ts";
import type { EmailChannelTransport } from "./email-transport.ts";
import type { RecipientSuppressionList } from "./recipient-suppression.ts";
import { verifySnsNotification, type SigningCertificateSource, type SnsNotificationFields } from "./sns-signature.ts";

/** One record of the event SNS hands a Lambda subscription. */
export interface SnsEventRecord {
	readonly EventSource?: unknown;
	readonly EventSubscriptionArn?: unknown;
	readonly Sns?: SnsNotificationFields;
}

/** The event SNS hands the status function. */
export interface SnsEvent {
	readonly Records?: readonly SnsEventRecord[];
}

/** What the status function trusts and writes. */
export interface MailStatusDependencies extends Pick<DeliveryDependencies, "runtime"> {
	readonly clock: Clock;
	readonly transport: EmailChannelTransport;
	readonly suppressionList: RecipientSuppressionList;
	readonly certificates: SigningCertificateSource;
	readonly expectedTopicArn: string;
	readonly region: string;
}

function subscriptionBelongsToTopic(record: SnsEventRecord, topicArn: string): boolean {
	return record.EventSubscriptionArn === undefined || (typeof record.EventSubscriptionArn === "string" && record.EventSubscriptionArn.startsWith(`${topicArn}:`));
}

/**
 * Handle the notifications of the configuration set's SNS topic. Each is verified first: a notification that is not signed by
 * SNS for the configured topic is counted by reason and dropped, never retried; a certificate that cannot be fetched throws,
 * so the platform retries. A verified notification moves the deliveries it names and suppresses the recipient of a permanent
 * bounce or a complaint.
 *
 * @param deps The trust settings and what the callback writes.
 * @param event The SNS event.
 * @returns How many notifications were applied and how many were rejected.
 * @throws Error When a signing certificate cannot be fetched.
 */
export async function handleSesStatusEvent(deps: MailStatusDependencies, event: SnsEvent): Promise<{ applied: number; rejected: number }> {
	let applied = 0;
	let rejected = 0;
	for (const record of event.Records ?? []) {
		const fields = record.Sns;
		const reject = (reason: string): void => {
			rejected += 1;
			deps.runtime.metrics.count("status_event_rejected", { provider: "email", reason });
		};
		if (record.EventSource !== "aws:sns" || fields === undefined) {
			reject("malformed");
			continue;
		}
		const verdict = await verifySnsNotification(fields, { expectedTopicArn: deps.expectedTopicArn, region: deps.region, certificates: deps.certificates, now: () => deps.clock.now() });
		if (verdict.kind === "rejected") {
			reject(verdict.reason);
			continue;
		}
		if (!subscriptionBelongsToTopic(record, deps.expectedTopicArn)) {
			reject("topic_arn");
			continue;
		}
		await applyEmailStatusCallback(
			{ runtime: deps.runtime, clock: deps.clock, suppressionList: deps.suppressionList },
			deps.transport,
			{ provider: "email", headers: {}, body: fields.Message as string, receivedAt: deps.clock.now() },
		);
		applied += 1;
		deps.runtime.metrics.count("status_event_applied", { provider: "email" });
	}
	return { applied, rejected };
}
