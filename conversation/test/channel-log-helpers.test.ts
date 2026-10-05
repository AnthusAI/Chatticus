import { describe, expect, it } from "vitest";
import { attributedWriteEntryDraft } from "../src/pi/channel-log.ts";
import { mailboxPartitionKey, mailboxSortKey } from "../src/pi/mailbox.ts";

describe("mailbox keys", () => {
	it("builds the partition key from tenant, bot and channel", () => {
		expect(mailboxPartitionKey("t1", "ada", "general")).toBe("MB#t1#ada#general");
	});

	it("pads the sort key to ten digits so keys sort in sequence order", () => {
		expect(mailboxSortKey(7)).toBe("0000000007");
		expect([mailboxSortKey(10), mailboxSortKey(9)].sort()).toEqual([mailboxSortKey(9), mailboxSortKey(10)]);
	});
});

describe("attributedWriteEntryDraft", () => {
	it("is a user-role entry whose text and data name the author", () => {
		const draft = attributedWriteEntryDraft({
			seq: 4,
			messageId: "m-4",
			authorKind: "human",
			authorId: "ryan",
			addressedToBotId: null,
			createdAt: "2026-10-05T10:00:04.000Z",
			body: "hello",
		});
		expect(draft.kind).toBe("pi.user");
		expect(draft.model[0]?.role).toBe("user");
		expect(draft.model[0]?.content[0]?.text).toBe("ryan: hello");
		expect(draft.data).toEqual({ messageId: "m-4", authorKind: "human", authorId: "ryan", body: "hello" });
	});
});
