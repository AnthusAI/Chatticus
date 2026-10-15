import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../src/domain/turns.ts";
import { turnEventItem } from "../src/store/turn-events.ts";
import { THINKING_CHARACTER_LIMIT } from "../src/turn/event-stream.ts";
import {
	MINIMUM_SECRET_LENGTH,
	redactSecrets,
	secretValuesOf,
	toolCallFields,
	toolResultFields,
} from "../src/turn/tool-event-fields.ts";

const WIDE = "€";
const MAXIMUM_EVENT_BYTES = 20_000;

const itemBytes = (event: TurnEvent): number => Buffer.byteLength(JSON.stringify(turnEventItem(event, new Date(0))));

const baseEvent = { eventId: "e".repeat(40), tenantId: "t".repeat(40), turnId: "u".repeat(40), channelId: "c".repeat(40), seq: 4_000_000 };

describe("secret selection", () => {
	it("takes the named secrets and every KEY, TOKEN or SECRET variable that is long enough", () => {
		const values = secretValuesOf({
			CHATTICUS_MODEL_GATEWAY_TOKEN: "gateway-token-value",
			MY_OWN_API_KEY: "api-key-value-123",
			SOME_SECRET: "secret-value-123",
			HARMLESS: "plain-value-123",
			SHORT_TOKEN: "abc",
		});
		expect(values.sort()).toEqual(["api-key-value-123", "gateway-token-value", "secret-value-123"]);
		expect("abc".length).toBeLessThan(MINIMUM_SECRET_LENGTH);
	});

	it("replaces the longer secret whole when one secret contains another", () => {
		const redacted = redactSecrets("x long-secret-value-extended y", { A_TOKEN: "long-secret-value", B_TOKEN: "long-secret-value-extended" });
		expect(redacted).toBe("x [redacted] y");
	});
});

describe("the largest possible event", () => {
	it("keeps a tool.call of every shape under the limit", () => {
		const wide = (length: number): string => WIDE.repeat(length);
		const shapes: Array<[string, Record<string, unknown>]> = [
			["run_terminal", { command: wide(5000) }],
			["write_workspace", { path: wide(5000), content: wide(5000) }],
			["edit_workspace", { path: wide(5000), old_text: wide(5000), new_text: wide(5000) }],
			["read_workspace", { path: wide(5000) }],
			["browse", { url: wide(5000) }],
			["anything_else", Object.fromEntries(Array.from({ length: 50 }, (_unused, index) => [wide(200) + index, wide(5000)]))],
		];
		for (const [tool, args] of shapes) {
			const fields = toolCallFields(tool, "c".repeat(80), args, {});
			expect(fields.argumentsTruncated).toBe(true);
			const bytes = itemBytes({
				...baseEvent,
				kind: "tool.call",
				tool: fields.tool,
				callId: fields.callId,
				summary: fields.summary,
				toolArguments: fields.toolArguments,
				argumentsTruncated: fields.argumentsTruncated,
			});
			expect(bytes, tool).toBeLessThan(MAXIMUM_EVENT_BYTES);
		}
	});

	it("keeps a tool.result under the limit", () => {
		const fields = toolResultFields("run_terminal", "c".repeat(80), WIDE.repeat(100_000), true, null, 123456789, {});
		expect(fields.outputTruncated).toBe(true);
		const bytes = itemBytes({
			...baseEvent,
			kind: "tool.result",
			tool: fields.tool,
			callId: fields.callId,
			ok: fields.ok,
			summary: fields.summary,
			output: fields.output,
			outputTruncated: fields.outputTruncated,
			durationMs: fields.durationMs,
		});
		expect(bytes).toBeLessThan(MAXIMUM_EVENT_BYTES);
	});

	it("keeps a turn.thinking event at the cap under the limit", () => {
		const bytes = itemBytes({ ...baseEvent, kind: "turn.thinking", text: WIDE.repeat(THINKING_CHARACTER_LIMIT) });
		expect(bytes).toBeLessThan(MAXIMUM_EVENT_BYTES);
	});
});
