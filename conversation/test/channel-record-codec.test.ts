import { describe, expect, it } from "vitest";
import type { ChannelMessageRecord } from "../src/domain/channels.ts";
import { ACTIVITY_RECORD_BYTE_LIMIT, fitActivityToRecord, type ToolActivityItem } from "../src/pi/message-activity.ts";
import { decodeMessage, encodeMessage, MESSAGE_BODY_LIMIT_BYTES, MessageBodyTooLargeError } from "../src/store/codecs/channel.ts";

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

	it("refuses a body that would not fit its row", () => {
		expect(() => encodeMessage({ ...record, body: "x".repeat(MESSAGE_BODY_LIMIT_BYTES + 1) })).toThrow(MessageBodyTooLargeError);
		expect(() => encodeMessage({ ...record, body: "x".repeat(MESSAGE_BODY_LIMIT_BYTES) })).not.toThrow();
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
