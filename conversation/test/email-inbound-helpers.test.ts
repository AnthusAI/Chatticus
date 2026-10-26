import { describe, expect, it } from "vitest";
import { channelCorrelatorTag, correlatorTagMatchesChannel } from "../src/channels/channel-correlator.ts";
import { UNKNOWN_CONTENT_TYPE, sanitizedAttachmentFileName, sanitizedContentType } from "../src/channels/email/attachment-metadata.ts";
import { automationHintsFromHeaders } from "../src/channels/email/automation-headers.ts";
import {
	MAXIMUM_REFERENCED_MESSAGE_IDS,
	ancestorMessageIds,
	emailConversationKey,
	messageIdsOfHeader,
	normalizeEmailAddress,
	normalizeMessageId,
	splitPlusTag,
} from "../src/channels/email/email-addresses.ts";
import { htmlToText } from "../src/channels/email/html-to-text.ts";
import { stripQuotedReplyAndSignature } from "../src/channels/email/quoted-reply.ts";

describe("email address helpers", () => {
	it("normalizes case, brackets and whitespace", () => {
		expect(normalizeEmailAddress(`  <Ada${"@"}Example.Test> `)).toBe("ada@example.test");
	});

	it("splits a plus tag from the routing address", () => {
		expect(splitPlusTag("bot+t7k2@org.mail.example.test")).toEqual({ routeAddress: "bot@org.mail.example.test", tag: "t7k2" });
		expect(splitPlusTag("bot@org.mail.example.test")).toEqual({ routeAddress: "bot@org.mail.example.test", tag: null });
		expect(splitPlusTag("bot+@org.mail.example.test")).toEqual({ routeAddress: "bot@org.mail.example.test", tag: null });
		expect(splitPlusTag("not-an-address")).toEqual({ routeAddress: "not-an-address", tag: null });
	});

	it("normalizes message ids and rejects unusable ones", () => {
		expect(normalizeMessageId(` <Abc${"@"}Host.Test> `)).toBe("abc@host.test");
		expect(normalizeMessageId("<>")).toBeNull();
		expect(normalizeMessageId("has space@host.test")).toBeNull();
		expect(normalizeMessageId(`<${"x".repeat(999)}>`)).toBeNull();
	});

	it("reads ids from bracketed and bare header values without duplicates", () => {
		expect(messageIdsOfHeader("<a@x.test> <B@x.test>\r\n <a@x.test>")).toEqual(["a@x.test", "b@x.test"]);
		expect(messageIdsOfHeader("a@x.test b@x.test")).toEqual(["a@x.test", "b@x.test"]);
		expect(messageIdsOfHeader(undefined)).toEqual([]);
		expect(messageIdsOfHeader("")).toEqual([]);
	});

	it("keys a thread by the first reference, else in-reply-to, else the message itself", () => {
		expect(emailConversationKey(["c"], ["a", "b"], "d")).toBe("a");
		expect(emailConversationKey(["c"], [], "d")).toBe("c");
		expect(emailConversationKey([], [], "d")).toBe("d");
	});

	it("orders ancestors nearest first and keeps the root of a very long chain", () => {
		expect(ancestorMessageIds(["c"], ["a", "b", "c"], "d")).toEqual(["c", "b", "a"]);
		expect(ancestorMessageIds([], ["d", "a"], "d")).toEqual(["a"]);
		const chain = Array.from({ length: 200 }, (_, index) => `m${index}`);
		const ancestors = ancestorMessageIds([], chain, "self");
		expect(ancestors).toHaveLength(MAXIMUM_REFERENCED_MESSAGE_IDS);
		expect(ancestors[0]).toBe("m199");
		expect(ancestors[ancestors.length - 1]).toBe("m0");
	});
});

describe("channel correlator tag", () => {
	it("is stable, short, address safe, and bound to the secret, tenant and channel", () => {
		const tag = channelCorrelatorTag("secret", "tenant-1", "channel-1");
		expect(tag).toMatch(/^[a-z2-7]{10}$/);
		expect(channelCorrelatorTag("secret", "tenant-1", "channel-1")).toBe(tag);
		expect(channelCorrelatorTag("other", "tenant-1", "channel-1")).not.toBe(tag);
		expect(channelCorrelatorTag("secret", "tenant-2", "channel-1")).not.toBe(tag);
		expect(channelCorrelatorTag("secret", "tenant-1", "channel-2")).not.toBe(tag);
	});

	it("matches only the exact tag, in any case", () => {
		const tag = channelCorrelatorTag("secret", "tenant-1", "channel-1");
		expect(correlatorTagMatchesChannel("secret", "tenant-1", "channel-1", tag.toUpperCase())).toBe(true);
		expect(correlatorTagMatchesChannel("secret", "tenant-1", "channel-1", `${tag}x`)).toBe(false);
		expect(correlatorTagMatchesChannel("secret", "tenant-1", "channel-1", "short")).toBe(false);
		expect(correlatorTagMatchesChannel("secret", "tenant-1", "channel-2", tag)).toBe(false);
	});
});

describe("html to text", () => {
	it("drops scripts, styles, comments and every image", () => {
		const text = htmlToText('<style>a{}</style><!-- hidden --><script>x()</script><p>Hi</p><img src="https://t.example.test/p.gif" alt="pixel">');
		expect(text).toBe("Hi");
	});

	it("decodes named and numeric entities and never produces markup from an escaped tag", () => {
		expect(htmlToText("<p>a &amp; b &lt;b&gt; &#65;&#x42; &unknown;</p>")).toBe("a & b <b> AB &unknown;");
	});

	it("keeps a link address only when it adds information", () => {
		expect(htmlToText('<a href="https://x.test/a?b=1&amp;c=2">docs</a>')).toBe("docs (https://x.test/a?b=1&c=2)");
		expect(htmlToText('<a href="https://x.test/a">https://x.test/a</a>')).toBe("https://x.test/a");
		expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe("click");
	});

	it("turns blocks into lines, list items into dashes and blockquotes into quoted lines", () => {
		expect(htmlToText("<div>One</div><div>Two<br>Three</div><ul><li>A</li><li>B</li></ul>")).toBe("One\nTwo\nThree\n\n- A\n- B");
		expect(htmlToText("<p>New</p><blockquote>Old<blockquote>Older</blockquote></blockquote>")).toBe("New\n\n> Old\n>> Older");
	});
});

describe("quoted reply stripping", () => {
	it("removes a trailing quote with a one-line or wrapped attribution", () => {
		expect(stripQuotedReplyAndSignature("Thanks.\n\nOn Mon, Ada wrote:\n> Hello\n> there")).toBe("Thanks.");
		expect(stripQuotedReplyAndSignature("Thanks.\n\nOn Mon 26 Oct 2026, Ada\n<ada@example.test> wrote:\n\n> Hello")).toBe("Thanks.");
	});

	it("keeps an inline reply whole", () => {
		const inline = "On Mon, Ada wrote:\n> One?\n\nYes.\n\n> Two?\n\nNo.";
		expect(stripQuotedReplyAndSignature(inline)).toBe(inline);
	});

	it("keeps a message that is nothing but a quote or an original-message block", () => {
		expect(stripQuotedReplyAndSignature("> all\n> quote")).toBe("> all\n> quote");
		expect(stripQuotedReplyAndSignature("-----Original Message-----\nFrom: x")).toBe("-----Original Message-----\nFrom: x");
	});

	it("cuts a short signature at the standard delimiter and keeps a long tail", () => {
		expect(stripQuotedReplyAndSignature("Hello\n-- \nAda\nLabs")).toBe("Hello");
		expect(stripQuotedReplyAndSignature("Hello\n--\nAda")).toBe("Hello");
		const longTail = `Hello\n-- \n${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}`;
		expect(stripQuotedReplyAndSignature(longTail)).toBe(longTail);
	});

	it("does not treat a dashed line inside a sentence as a signature", () => {
		expect(stripQuotedReplyAndSignature("a -- b\nsecond line")).toBe("a -- b\nsecond line");
	});

	it("normalizes line endings", () => {
		expect(stripQuotedReplyAndSignature("a\r\nb\r\n")).toBe("a\nb");
	});
});

describe("automation headers", () => {
	const headers = (...entries: Array<[string, string]>) => entries.map(([key, value]) => ({ key, value }));

	it("reads every automation signal from the headers", () => {
		const hints = automationHintsFromHeaders(
			headers(["auto-submitted", "auto-replied"], ["precedence", "bulk"], ["list-id", "<l.example.test>"], ["x-chatticus-origin", "development"], ["return-path", "<>"]),
			"someone@example.test",
		);
		expect(hints).toEqual({ autoSubmitted: true, bulkPrecedence: true, bounceReport: true, listMail: true, ownOrigin: true });
	});

	it("treats Auto-Submitted no, with or without a comment, as ordinary mail", () => {
		expect(automationHintsFromHeaders(headers(["auto-submitted", "no"]), "a@example.test").autoSubmitted).toBe(false);
		expect(automationHintsFromHeaders(headers(["auto-submitted", "no (typed by a person)"]), "a@example.test").autoSubmitted).toBe(false);
	});

	it("recognizes machine senders and delivery reports by sender or content type", () => {
		expect(automationHintsFromHeaders([], "mailer-daemon@example.test").bounceReport).toBe(true);
		expect(automationHintsFromHeaders([], "no-reply@example.test").autoSubmitted).toBe(true);
		expect(automationHintsFromHeaders(headers(["content-type", "multipart/report; report-type=delivery-status"]), "a@example.test").bounceReport).toBe(true);
		expect(automationHintsFromHeaders(headers(["return-path", "<a@example.test>"]), "a@example.test")).toEqual({
			autoSubmitted: false,
			bulkPrecedence: false,
			bounceReport: false,
			listMail: false,
			ownOrigin: false,
		});
	});
});

describe("attachment metadata", () => {
	it("keeps only a clean base name", () => {
		expect(sanitizedAttachmentFileName("../../etc/passwd")).toBe("passwd");
		expect(sanitizedAttachmentFileName("C:\\Users\\a\\report.pdf")).toBe("report.pdf");
		expect(sanitizedAttachmentFileName("pass\u0000wd\n")).toBe("passwd");
		expect(sanitizedAttachmentFileName("..")).toBe("");
		expect(sanitizedAttachmentFileName(null)).toBe("");
		expect(sanitizedAttachmentFileName("x".repeat(400))).toHaveLength(255);
	});

	it("keeps a well formed media type and replaces anything else with the generic binary type", () => {
		expect(sanitizedContentType("Application/PDF")).toBe("application/pdf");
		expect(sanitizedContentType("text/plain\u0000")).toBe("text/plain");
		expect(sanitizedContentType("not a type")).toBe(UNKNOWN_CONTENT_TYPE);
		expect(sanitizedContentType("")).toBe(UNKNOWN_CONTENT_TYPE);
	});
});
