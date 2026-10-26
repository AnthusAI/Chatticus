import { X509Certificate, createVerify } from "node:crypto";

/** An SNS notification as a Lambda subscription delivers it, in the `Sns` member of a record. */
export interface SnsNotificationFields {
	readonly Type?: unknown;
	readonly MessageId?: unknown;
	readonly TopicArn?: unknown;
	readonly Subject?: unknown;
	readonly Message?: unknown;
	readonly Timestamp?: unknown;
	readonly SignatureVersion?: unknown;
	readonly Signature?: unknown;
	readonly SigningCertUrl?: unknown;
}

/** Why a notification was not believed. */
export type SnsRejectionReason =
	| "malformed"
	| "unsupported_type"
	| "unsigned"
	| "signature_version"
	| "signing_certificate_url"
	| "topic_arn"
	| "timestamp"
	| "signature";

/** The verdict on one notification. */
export type SnsVerdict = { readonly kind: "verified" } | { readonly kind: "rejected"; readonly reason: SnsRejectionReason };

/** Where signing certificates come from; the production source fetches the PEM over https and tests serve one from memory. */
export interface SigningCertificateSource {
	/** The PEM of the certificate at the address; throws when it cannot be had, which is not a verdict about the message. */
	fetch(url: string): Promise<string>;
}

/** What the verifier trusts. */
export interface SnsVerificationOptions {
	/** The only topic whose notifications are believed. */
	readonly expectedTopicArn: string;
	/** The region whose SNS endpoint serves the signing certificate. */
	readonly region: string;
	readonly certificates: SigningCertificateSource;
	readonly now: () => Date;
}

/** How old a notification may be: a retried invocation of the platform may deliver it late. */
export const SNS_MAXIMUM_AGE_SECONDS = 2 * 60 * 60;

/** How far in the future a timestamp may be, to allow for clock difference. */
export const SNS_MAXIMUM_FUTURE_SECONDS = 5 * 60;

const CERTIFICATE_PATH_PATTERN = /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/;

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The canonical address of a signing certificate that SNS of the region serves, or null when the address is not one: https,
 * exactly `sns.<region>.amazonaws.com`, no port, no credentials, no query, and the plain path SNS uses. The check is made on
 * the parsed address, and the parsed form is what is returned, so the address that is fetched and cached is the one that was
 * checked, whatever rewriting the parser applied (default port, dot segments, host case, embedded tabs and newlines).
 *
 * @param address The SigningCertUrl of the notification.
 * @param region The region of the topic.
 * @returns The canonical address, or null when it may not be fetched.
 */
export function snsSigningCertificateHref(address: string, region: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(address);
	} catch {
		return null;
	}
	const acceptable =
		parsed.protocol === "https:" &&
		parsed.hostname === `sns.${region}.amazonaws.com` &&
		parsed.port === "" &&
		parsed.username === "" &&
		parsed.password === "" &&
		parsed.search === "" &&
		parsed.hash === "" &&
		CERTIFICATE_PATH_PATTERN.test(parsed.pathname);
	return acceptable ? parsed.href : null;
}

/**
 * The string SNS signs for a notification: the named fields in alphabetical order, each as its name and its value on a
 * line of its own. The subject is part of it only when the notification has one.
 *
 * @param fields The notification.
 * @returns The canonical string, or null when a field it needs is missing.
 */
export function snsNotificationCanonicalString(fields: SnsNotificationFields): string | null {
	const message = text(fields.Message);
	const messageId = text(fields.MessageId);
	const timestamp = text(fields.Timestamp);
	const topicArn = text(fields.TopicArn);
	if (message === null || messageId === null || timestamp === null || topicArn === null) return null;
	const subject = fields.Subject === undefined || fields.Subject === null ? null : text(fields.Subject);
	if (fields.Subject !== undefined && fields.Subject !== null && subject === null) return null;
	const parts = [["Message", message], ["MessageId", messageId], ...(subject === null ? [] : [["Subject", subject]]), ["Timestamp", timestamp], ["TopicArn", topicArn], ["Type", "Notification"]];
	return parts.map(([name, value]) => `${name}\n${value}\n`).join("");
}

function timestampIsRecent(timestamp: string, now: Date): boolean {
	const stamped = Date.parse(timestamp);
	if (Number.isNaN(stamped)) return false;
	const ageSeconds = (now.getTime() - stamped) / 1000;
	return ageSeconds <= SNS_MAXIMUM_AGE_SECONDS && ageSeconds >= -SNS_MAXIMUM_FUTURE_SECONDS;
}

/**
 * Decide whether an SNS notification really came from SNS for the configured topic. Every check must pass: the type is a
 * notification, a signature is present, the signature version is 1 or 2, the signing certificate is served by SNS of the
 * region, the topic is the configured one, the timestamp is recent, and the signature verifies over the canonical string with
 * the certificate's public key. A certificate that cannot be fetched throws, because that says nothing about the message.
 *
 * @param fields The notification.
 * @param options What the verifier trusts.
 * @returns Verified, or the first reason the notification is not believed.
 * @throws Error When the signing certificate cannot be fetched.
 */
export async function verifySnsNotification(fields: SnsNotificationFields, options: SnsVerificationOptions): Promise<SnsVerdict> {
	const rejected = (reason: SnsRejectionReason): SnsVerdict => ({ kind: "rejected", reason });
	const canonical = snsNotificationCanonicalString(fields);
	if (canonical === null) return rejected("malformed");
	if (fields.Type !== "Notification") return rejected("unsupported_type");
	const signature = text(fields.Signature);
	if (signature === null) return rejected("unsigned");
	const algorithm = fields.SignatureVersion === "1" ? "RSA-SHA1" : fields.SignatureVersion === "2" ? "RSA-SHA256" : null;
	if (algorithm === null) return rejected("signature_version");
	const certificateUrl = snsSigningCertificateHref(text(fields.SigningCertUrl) ?? "", options.region);
	if (certificateUrl === null) return rejected("signing_certificate_url");
	if (fields.TopicArn !== options.expectedTopicArn) return rejected("topic_arn");
	if (!timestampIsRecent(fields.Timestamp as string, options.now())) return rejected("timestamp");
	const pem = await options.certificates.fetch(certificateUrl);
	try {
		const publicKey = new X509Certificate(pem).publicKey;
		const valid = createVerify(algorithm).update(canonical, "utf8").verify(publicKey, Buffer.from(signature, "base64"));
		return valid ? { kind: "verified" } : rejected("signature");
	} catch {
		return rejected("signature");
	}
}

/** How long a fetched certificate is kept in the process. */
export const CERTIFICATE_CACHE_SECONDS = 60 * 60;

/** How many certificates are kept in the process; the oldest is dropped first. */
export const CERTIFICATE_CACHE_ENTRIES = 8;

const MAXIMUM_CERTIFICATE_BYTES = 16 * 1024;

/** Fetches signing certificates over https with a time limit and a size limit, and keeps them for a while. */
export class HttpsSigningCertificateSource implements SigningCertificateSource {
	private readonly cache = new Map<string, { readonly pem: string; readonly fetchedAt: number }>();
	private readonly now: () => Date;
	private readonly fetcher: typeof fetch;

	/**
	 * @param now The clock.
	 * @param fetcher The fetch function; the global one by default.
	 */
	constructor(now: () => Date = () => new Date(), fetcher: typeof fetch = fetch) {
		this.now = now;
		this.fetcher = fetcher;
	}

	async fetch(url: string): Promise<string> {
		const cached = this.cache.get(url);
		const nowMilliseconds = this.now().getTime();
		if (cached !== undefined && nowMilliseconds - cached.fetchedAt < CERTIFICATE_CACHE_SECONDS * 1000) return cached.pem;
		const response = await this.fetcher(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
		if (!response.ok) throw new Error(`The signing certificate answered ${response.status}.`);
		const pem = await response.text();
		if (pem.length > MAXIMUM_CERTIFICATE_BYTES) throw new Error("The signing certificate is too large.");
		this.cache.delete(url);
		this.cache.set(url, { pem, fetchedAt: nowMilliseconds });
		while (this.cache.size > CERTIFICATE_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
		return pem;
	}
}
