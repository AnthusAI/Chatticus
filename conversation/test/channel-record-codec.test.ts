import { describe, expect, it } from "vitest";
import type { ChannelMessageRecord } from "../src/domain/channels.ts";
import { ACTIVITY_RECORD_BYTE_LIMIT, fitActivityToRecord, type ToolActivityItem } from "../src/pi/message-activity.ts";
import {
	decodeMessage,
	encodeMessage,
	encodeMessageItems,
	MESSAGE_BODY_INLINE_BYTES,
	MESSAGE_BODY_MAX_BYTES,
	MESSAGE_BODY_PART_BYTES,
	MessageBodyTooLargeError,
	splitBody,
} from "../src/store/codecs/channel.ts";

const record: ChannelMessageRecord = {
	messageId: "m-1",
	channelId: "c-1",
	tenantId: "t-1",
	seq: 3,
	authorKind: "bot",
	authorId: "bot-1",
	body: "done",
	addressedToBotId: null,
	createdAt: new Date("2026-11-02T10:00:00.000Z"),
};

const callOf = (index: number, output: string): ToolActivityItem => ({
	call_id: `call-${index}`,
	tool: "bash",
	summary: "Running",
	arguments: {},
	arguments_truncated: false,
	ok: true,
	result_summary: null,
	output,
	output_truncated: false,
	duration_ms: 1,
});

describe("channel record codec", () => {
	it("round trips activity, the turn it answers, and a tombstone", () => {
		const full: ChannelMessageRecord = { ...record, inReplyToSeq: 2, activity: [callOf(1, "ok")] };
		expect(decodeMessage(encodeMessage(full))).toEqual(full);
		const deleted: ChannelMessageRecord = { ...record, body: "", inReplyToSeq: 2, deletedAt: new Date("2026-11-03T00:00:00.000Z") };
		expect(decodeMessage(encodeMessage(deleted))).toEqual(deleted);
	});

	it("keeps the origin the codec used to drop", () => {
		const origin = {
			bindingId: "b",
			provider: "email",
			externalMessageId: "e",
			conversationKey: "k",
			senderExternalId: "s",
			assertion: "dkim_aligned" as const,
		};
		expect(decodeMessage(encodeMessage({ ...record, origin })).origin).toEqual(origin);
	});

	it("keeps a body up to the inline limit in its row", () => {
		const { row, parts } = encodeMessageItems({ ...record, body: "x".repeat(MESSAGE_BODY_INLINE_BYTES) });
		expect(parts).toEqual([]);
		expect(row.body_parts).toBeUndefined();
	});

	it("carries a longer body in continuation items that decode back to the whole text", () => {
		const body = "é".repeat(400_000);
		const { row, parts } = encodeMessageItems({ ...record, body });
		expect(row.body).toEqual({ S: "" });
		expect(parts.length).toBe(Math.ceil(Buffer.byteLength(body, "utf8") / MESSAGE_BODY_PART_BYTES));
		expect(decodeMessage(row, parts).body).toBe(body);
	});

	it("refuses a body longer than the record keeps", () => {
		expect(() => encodeMessageItems({ ...record, body: "x".repeat(MESSAGE_BODY_MAX_BYTES + 1) })).toThrow(MessageBodyTooLargeError);
		expect(() => encodeMessageItems({ ...record, body: "x".repeat(MESSAGE_BODY_MAX_BYTES) })).not.toThrow();
	});
});

describe("splitBody", () => {
	it("never cuts inside a character", () => {
		const pieces = splitBody("😀".repeat(10), 10);
		expect(pieces.every((piece) => Buffer.byteLength(piece, "utf8") <= 10)).toBe(true);
		expect(pieces.join("")).toBe("😀".repeat(10));
	});
});

describe("fitActivityToRecord", () => {
	it("keeps activity that fits", () => {
		const items = [callOf(1, "a"), callOf(2, "b")];
		expect(fitActivityToRecord(items)).toEqual(items);
	});

	it("keeps the first calls that fit and ends with an item that counts the rest", () => {
		const items = Array.from({ length: 40 }, (_, index) => callOf(index, "x".repeat(10_000)));
		const fitted = fitActivityToRecord(items);
		expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(ACTIVITY_RECORD_BYTE_LIMIT);
		const counting = fitted.at(-1)!;
		expect(counting.call_id).toBe("more");
		expect(fitted.length - 1 + Number(counting.summary.split(" ")[0])).toBe(40);
	});
});
