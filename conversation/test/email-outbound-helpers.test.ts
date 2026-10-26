import { describe, expect, it } from "vitest";
import { isOwnOutboundMessageId, outboundMessageId } from "../src/channels/email/outbound-message-id.ts";
import { DEFAULT_REPLY_SUBJECT, encodedHeaderValue, outboundMimeBytes, replySubject, singleLineHeaderText } from "../src/channels/email/outbound-mime.ts";
import { sesStatusFacts } from "../src/channels/email/ses-event-notification.ts";

const reply = { tenantId: "tenant-1", messageId: "message-1", bindingId: "binding-1" };

describe("outbound message id", () => {
	it("is stable for one reply and different for another", () => {
		expect(outboundMessageId("secret", "mail.example.test", reply)).toBe(outboundMessageId("secret", "mail.example.test", reply));
		expect(outboundMessageId("secret", "mail.example.test", reply)).not.toBe(outboundMessageId("secret", "mail.example.test", { ...reply, messageId: "message-2" }));
	});

	it("is recognized with or without brackets under the same secret and domain only", () => {
		const id = outboundMessageId("secret", "mail.example.test", reply);
		expect(isOwnOutboundMessageId("secret", "mail.example.test", id)).toBe(true);
		expect(isOwnOutboundMessageId("secret", "mail.example.test", `<${id.toUpperCase()}>`)).toBe(true);
		expect(isOwnOutboundMessageId("other-secret", "mail.example.test", id)).toBe(false);
		expect(isOwnOutboundMessageId("secret", "mail.other.test", id)).toBe(false);
	});

	it("rejects ids that only look like ours", () => {
		expect(isOwnOutboundMessageId("secret", "mail.example.test", "chatticus.0123456789abcdef0123.0123456789ab@mail.example.test")).toBe(false);
		expect(isOwnOutboundMessageId("secret", "mail.example.test", "plain-id@mail.example.test")).toBe(false);
		expect(isOwnOutboundMessageId("secret", "mail.example.test", "")).toBe(false);
	});
});

describe("reply subject", () => {
	it("keeps one Re prefix", () => {
		expect(replySubject("Plan")).toBe("Re: Plan");
		expect(replySubject("RE: re[2]: Re: Plan")).toBe("Re: Plan");
	});

	it("falls back when nothing is left", () => {
		expect(replySubject(null)).toBe(DEFAULT_REPLY_SUBJECT);
		expect(replySubject("Re:")).toBe(DEFAULT_REPLY_SUBJECT);
	});

	it("puts a subject on one line", () => {
		expect(replySubject("Plan\r\nBcc: x@example.test")).toBe("Re: Plan Bcc: x@example.test");
		expect(singleLineHeaderText("a b\tc")).toBe("a b c");
	});
});

describe("header encoding", () => {
	it("leaves printable ASCII alone and encodes the rest without splitting a character", () => {
		expect(encodedHeaderValue("Plain subject")).toBe("Plain subject");
		const encoded = encodedHeaderValue("Café 😀".repeat(12));
		for (const word of encoded.split("\r\n ")) {
			expect(word.length).toBeLessThanOrEqual(75);
			expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		}
		const decoded = encoded.split("\r\n ").map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("");
		expect(decoded).toBe("Café 😀".repeat(12));
	});
});

describe("mime bytes", () => {
	it("writes CRLF headers, a base64 body and no extra header from a hostile value", () => {
		const text = Buffer.from(outboundMimeBytes({ headers: [["To", "a@example.test\r\nBcc: b@example.test"]], subject: "S", text: "Line one\nLine two" })).toString("latin1");
		const [head, body] = text.split("\r\n\r\n");
		expect(head!.split("\r\n").filter((line) => /^bcc:/i.test(line))).toEqual([]);
		expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Line one\r\nLine two");
	});
});

describe("ses status facts", () => {
	const wrap = (event: object): string => JSON.stringify({ Type: "Notification", Message: JSON.stringify(event) });

	it("reads a permanent bounce with its recipients", () => {
		const facts = sesStatusFacts(wrap({ eventType: "Bounce", mail: { messageId: "m1" }, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "A@Example.test" }] } }));
		expect(facts).toEqual([{ event: { provider: "email", providerMessageId: "m1", status: "bounced", reason: "bounce_permanent_general" }, suppressAddresses: ["a@example.test"] }]);
	});

	it("reads an event that is not wrapped by SNS", () => {
		expect(sesStatusFacts(JSON.stringify({ eventType: "Delivery", mail: { messageId: "m1" } }))).toHaveLength(1);
	});

	it("ignores sends, transient bounces and unreadable bodies", () => {
		expect(sesStatusFacts(wrap({ eventType: "Send", mail: { messageId: "m1" } }))).toEqual([]);
		expect(sesStatusFacts(wrap({ eventType: "Bounce", mail: { messageId: "m1" }, bounce: { bounceType: "Transient" } }))).toEqual([]);
		expect(sesStatusFacts("nonsense")).toEqual([]);
		expect(sesStatusFacts("null")).toEqual([]);
		expect(sesStatusFacts(wrap({ eventType: "Delivery" }))).toEqual([]);
	});
});
