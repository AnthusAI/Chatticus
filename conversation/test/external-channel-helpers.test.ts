import { describe, expect, it } from "vitest";
import { botMailAddress, botMailLocalPart, mailHandleProblem } from "../src/channels/mail-handle.ts";
import { externalChannelId } from "../src/channels/conversation-mapping.ts";
import { normalizedRouteKey } from "../src/store/channel-store.ts";

describe("mail handle helpers", () => {
	it("accepts a lowercase DNS label and refuses anything else", () => {
		expect(mailHandleProblem("anthus-labs")).toBeNull();
		expect(mailHandleProblem("a")).toBeNull();
		expect(mailHandleProblem("")).toBe("not_a_dns_label");
		expect(mailHandleProblem("a".repeat(64))).toBe("not_a_dns_label");
		expect(mailHandleProblem("Anthus")).toBe("not_a_dns_label");
		expect(mailHandleProblem("anthus_labs")).toBe("not_a_dns_label");
		expect(mailHandleProblem("admin")).toBe("reserved");
	});

	it("derives a local part from a bot name", () => {
		expect(botMailLocalPart("Lead Analyst")).toBe("lead-analyst");
		expect(botMailLocalPart("  R&D -- Bot!  ")).toBe("r-d-bot");
		expect(botMailLocalPart("!!!")).toBe("");
		expect(botMailLocalPart("x".repeat(100))).toHaveLength(64);
	});

	it("builds an address, or none when the name has no usable character", () => {
		expect(botMailAddress("Researcher", "anthus", "mail.example.test")).toBe("researcher@anthus.mail.example.test");
		expect(botMailAddress("???", "anthus", "mail.example.test")).toBeNull();
	});
});

describe("external channel identity", () => {
	it("is the same for the same conversation and differs by tenant, binding and key", () => {
		const base = externalChannelId("t1", "b1", "thread");
		expect(externalChannelId("t1", "b1", "thread")).toBe(base);
		expect(externalChannelId("t2", "b1", "thread")).not.toBe(base);
		expect(externalChannelId("t1", "b2", "thread")).not.toBe(base);
		expect(externalChannelId("t1", "b1", "other")).not.toBe(base);
	});

	it("does not confuse key boundaries", () => {
		expect(externalChannelId("t1", "b1c", "d")).not.toBe(externalChannelId("t1", "b1", "cd"));
	});
});

describe("route keys", () => {
	it("compare case-insensitively and ignore surrounding space", () => {
		expect(normalizedRouteKey("  Researcher-LINE ")).toBe("researcher-line");
	});
});
