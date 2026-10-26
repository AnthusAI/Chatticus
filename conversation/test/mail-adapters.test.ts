import { describe, expect, it } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { classifySesV2Failure, SesV2MailClient } from "../src/channels/email/ses-v2-mail-client.ts";
import { SesSendError } from "../src/channels/email/ses-mail-client.ts";
import { S3RawMailReader } from "../src/channels/email/raw-mail-store.ts";
import { CERTIFICATE_CACHE_ENTRIES, HttpsSigningCertificateSource, snsNotificationCanonicalString, snsSigningCertificateHref } from "../src/channels/email/sns-signature.ts";
import { lazyHandler } from "../src/lambdas/mail-composition.ts";

const failure = (name: string, message = "", status = 400) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });

describe("the SES v2 failure classification", () => {
	it.each([
		["TooManyRequestsException", "", 400, "throttled"],
		["LimitExceededException", "", 400, "throttled"],
		["InternalServiceErrorException", "", 500, "unavailable"],
		["SomethingElse", "", 503, "unavailable"],
		["MessageRejected", "Email address is not verified. The following identities failed the check in region US-EAST-1", 400, "sandbox_unverified_recipient"],
		["MessageRejected", "Address is on the account suppression list", 400, "suppressed"],
		["MessageRejected", "Other", 400, "rejected"],
		["AccountSuspendedException", "", 400, "rejected"],
		["SendingPausedException", "", 400, "rejected"],
	] as const)("maps %s to %s", (name, message, status, kind) => {
		expect(classifySesV2Failure(failure(name, message, status))).toBe(kind);
	});

	it("leaves an error SES did not decide about unclassified", () => {
		expect(classifySesV2Failure(new Error("socket hang up"))).toBeNull();
		expect(classifySesV2Failure(null)).toBeNull();
	});
});

describe("the SES v2 mail client", () => {
	const request = { fromAddress: "bot AT mail.example.test".replace(" AT ", "@"), destinations: ["to AT example.test".replace(" AT ", "@")], rawMessage: new Uint8Array([1, 2]), configurationSetName: "set" };

	it("sends raw content through the configuration set and returns the message id", async () => {
		const sent: SendEmailCommand[] = [];
		const client = new SesV2MailClient({ send: async (command) => (sent.push(command), { MessageId: "abc" }) });
		expect(await client.sendRawEmail(request)).toEqual({ messageId: "abc" });
		expect(sent[0]!.input.ConfigurationSetName).toBe("set");
		expect(sent[0]!.input.Content?.Raw?.Data).toEqual(request.rawMessage);
		expect(sent[0]!.input.Destination?.ToAddresses).toEqual(request.destinations);
	});

	it("throws a classified error for a refusal and the original error for anything else", async () => {
		const refusing = new SesV2MailClient({ send: async () => Promise.reject(failure("TooManyRequestsException")) });
		await expect(refusing.sendRawEmail(request)).rejects.toMatchObject({ kind: "throttled" });
		await expect(refusing.sendRawEmail(request)).rejects.toBeInstanceOf(SesSendError);
		const broken = new SesV2MailClient({ send: async () => Promise.reject(new Error("socket hang up")) });
		await expect(broken.sendRawEmail(request)).rejects.toThrow("socket hang up");
	});

	it("treats an answer with no message id as unavailable", async () => {
		const client = new SesV2MailClient({ send: async () => ({}) });
		await expect(client.sendRawEmail(request)).rejects.toMatchObject({ kind: "unavailable" });
	});
});

describe("the raw mail archive reader", () => {
	it("returns the bytes, reports a missing key, and rethrows every other failure", async () => {
		const bytes = new Uint8Array([7, 8]);
		const body = { transformToByteArray: async () => bytes } as never;
		expect(await new S3RawMailReader({ send: async () => ({ Body: body, ContentLength: 2 }) }, "bucket").read("raw/a", 10)).toEqual({ kind: "found", bytes });
		expect(await new S3RawMailReader({ send: async () => Promise.reject(Object.assign(new Error("x"), { name: "NoSuchKey" })) }, "bucket").read("raw/a", 10)).toEqual({ kind: "missing" });
		await expect(new S3RawMailReader({ send: async () => Promise.reject(Object.assign(new Error("denied"), { name: "AccessDenied" })) }, "bucket").read("raw/a", 10)).rejects.toThrow("denied");
	});

	it("refuses an object above the limit by its content length without reading the body", async () => {
		let bodyRead = false;
		let destroyed = false;
		const body = { transformToByteArray: async () => ((bodyRead = true), new Uint8Array()), destroy: () => void (destroyed = true) } as never;
		const reader = new S3RawMailReader({ send: async () => ({ Body: body, ContentLength: 11 }) }, "bucket");
		expect(await reader.read("raw/a", 10)).toEqual({ kind: "too_large", sizeBytes: 11 });
		expect(bodyRead).toBe(false);
		expect(destroyed).toBe(true);
	});
});

describe("the SNS signing helpers", () => {
	it("returns the canonical address of a certificate served by SNS of the region and nothing else", () => {
		expect(snsSigningCertificateHref("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem", "us-east-1")).toBe("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem");
		expect(snsSigningCertificateHref("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem", "eu-west-1")).toBeNull();
		expect(snsSigningCertificateHref("not a url", "us-east-1")).toBeNull();
	});

	it("builds the canonical string in alphabetical order and leaves out an absent subject", () => {
		const fields = { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "body", Timestamp: "ts", Subject: null };
		expect(snsNotificationCanonicalString(fields)).toBe("Message\nbody\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n");
		expect(snsNotificationCanonicalString({ ...fields, Subject: "s" })).toBe("Message\nbody\nMessageId\nm\nSubject\ns\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n");
		expect(snsNotificationCanonicalString({ ...fields, Message: undefined })).toBeNull();
	});
});

describe("the lazily composed handler", () => {
	it("composes once, and tries again after a failed composition", async () => {
		let compositions = 0;
		const handler = lazyHandler<number, number>(async () => {
			compositions += 1;
			if (compositions === 1) throw new Error("not yet");
			return async (event) => event + 1;
		});
		await expect(handler(1)).rejects.toThrow("not yet");
		expect(await handler(1)).toBe(2);
		expect(await handler(2)).toBe(3);
		expect(compositions).toBe(2);
	});
});

describe("the signing certificate source", () => {
	it("keeps at most the configured number of certificates, dropping the oldest, and fetches each address once while it is cached", async () => {
		let fetches = 0;
		const fetcher = (async () => ((fetches += 1), new Response("pem"))) as unknown as typeof fetch;
		const source = new HttpsSigningCertificateSource(() => new Date(0), fetcher);
		for (let index = 0; index <= CERTIFICATE_CACHE_ENTRIES; index += 1) await source.fetch(`https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${index}.pem`);
		expect(fetches).toBe(CERTIFICATE_CACHE_ENTRIES + 1);
		await source.fetch(`https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${CERTIFICATE_CACHE_ENTRIES}.pem`);
		expect(fetches).toBe(CERTIFICATE_CACHE_ENTRIES + 1);
		await source.fetch("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0.pem");
		expect(fetches).toBe(CERTIFICATE_CACHE_ENTRIES + 2);
	});
});
