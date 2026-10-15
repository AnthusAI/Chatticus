import { describe, expect, it } from "vitest";
import { parseSseFrames } from "../src/acceptance/sse-parser.ts";

describe("parseSseFrames", () => {
	it("parses a complete SSE frame", () => {
		const chunk = 'event:turn.token\nid:123\ndata:{"token":"hello"}\n\n';
		const { frames, carry } = parseSseFrames(chunk, "");

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({
			event: "turn.token",
			id: "123",
			data: '{"token":"hello"}',
		});
		expect(carry).toBe("");
	});

	it("ignores comment lines starting with colon", () => {
		const chunk = ':comment\ndata:test\n\n';
		const { frames } = parseSseFrames(chunk, "");

		expect(frames).toHaveLength(1);
		expect(frames[0].data).toBe("test");
	});

	it("carries over incomplete frames", () => {
		const chunk = 'data:{"part":"1"}';
		const { frames, carry } = parseSseFrames(chunk, "");

		expect(frames).toHaveLength(0);
		expect(carry).toBe('data:{"part":"1"}');
	});

	it("handles multiple complete frames", () => {
		const chunk = 'data:a\n\ndata:b\n\n';
		const { frames } = parseSseFrames(chunk, "");

		expect(frames).toHaveLength(2);
		expect(frames[0].data).toBe("a");
		expect(frames[1].data).toBe("b");
	});

	it("combines carry with new chunk", () => {
		const carry = 'data:first';
		const chunk = '\n\ndata:second\n\n';
		const { frames } = parseSseFrames(chunk, carry);

		expect(frames).toHaveLength(2);
		expect(frames[0].data).toBe("first");
		expect(frames[1].data).toBe("second");
	});

	it("handles frames without all fields", () => {
		const chunk = 'data:minimal\n\n';
		const { frames } = parseSseFrames(chunk, "");

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({
			event: "",
			id: null,
			data: "minimal",
		});
	});
});
