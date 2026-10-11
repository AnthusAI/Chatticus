import { describe, expect, it } from "vitest";
import { OWNER_SESSION_TAG_KEYS, OwnerSessionTagError, ownerSessionTags, type OwnerSessionScope } from "../src/gateway/session-tags.ts";

const uuid = "0f8c2a1e-9b7d-4c3a-8e5f-1a2b3c4d5e6f";

const scope: OwnerSessionScope = {
	tenantId: "anthus",
	botId: `bot-${uuid}`,
	channelId: `channel-${uuid}`,
	computerId: `computer-${uuid}`,
	turnId: "0000000004",
};

describe("ownerSessionTags", () => {
	it("returns the five lower-case keys in order with the ids as values", () => {
		expect(ownerSessionTags(scope)).toEqual([
			{ Key: "tenant", Value: "anthus" },
			{ Key: "bot", Value: `bot-${uuid}` },
			{ Key: "channel", Value: `channel-${uuid}` },
			{ Key: "computer", Value: `computer-${uuid}` },
			{ Key: "turn", Value: "0000000004" },
		]);
		expect(ownerSessionTags(scope).map((tag) => tag.Key)).toEqual([...OWNER_SESSION_TAG_KEYS]);
	});

	it("accepts the id shapes the platform generates", () => {
		for (const tenantId of ["anthus", "integration-test", uuid, "household-tenant-with-a-long-name-0123", "a.b:c_d"]) {
			expect(() => ownerSessionTags({ ...scope, tenantId })).not.toThrow();
		}
	});

	it.each(["", "bot*", "bot?", "bot#other", "bot%23", "bot id", "bot/1", "bot=1", "bot+1", "bot@1", "bot$", "bot{x}", "x".repeat(257)])(
		"refuses the bot id %j",
		(botId) => {
			expect(() => ownerSessionTags({ ...scope, botId })).toThrow(OwnerSessionTagError);
		},
	);

	it("names the offending tag in the error and never rewrites a value", () => {
		expect(() => ownerSessionTags({ ...scope, channelId: "chan nel" })).toThrow(/channel id "chan nel"/);
	});
});
