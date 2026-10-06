import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../src/domain/turns.ts";
import {
	decodePendingComputerTool,
	encodePendingComputerTool,
	turnEventFromItem,
	turnEventItem,
	turnEventSortKey,
	turnItemPartitionKey,
} from "../src/store/turn-events.ts";

describe("turn event items", () => {
	it("keys events by tenant turn partition and a ten digit sequence", () => {
		expect(turnItemPartitionKey("anthus", "turn-1")).toBe("anthus#turn#turn-1");
		expect(turnEventSortKey(7)).toBe("evt#0000000007");
	});

	it("writes the time to live in expires_at as epoch seconds", () => {
		const event: TurnEvent = {
			eventId: "e1",
			tenantId: "anthus",
			turnId: "turn-1",
			channelId: "channel-1",
			seq: 3,
			kind: "turn.token",
			token: "hello",
		};
		const item = turnEventItem(event, new Date("2026-10-06T10:00:00Z"));
		expect(item.expires_at).toEqual({ N: String(Date.parse("2026-10-06T10:00:00Z") / 1000) });
		expect(item.seq).toEqual({ N: "3" });
	});

	it("round trips every optional field and omits the absent ones", () => {
		const event: TurnEvent = {
			eventId: "e2",
			tenantId: "anthus",
			turnId: "turn-1",
			channelId: "channel-1",
			seq: 4,
			kind: "turn.waiting",
			body: "browser",
			attemptId: "attempt-1",
			actionId: "action-1",
			messageSeq: 9,
			pendingComputerTool: { actionId: "a", toolName: "request_computer_capability", arguments: { gate: "browser" } },
		};
		expect(turnEventFromItem(turnEventItem(event, new Date(0)))).toEqual(event);
		const bare = turnEventItem({ ...event, body: undefined, attemptId: undefined, actionId: undefined, messageSeq: undefined, pendingComputerTool: undefined }, new Date(0));
		expect(Object.keys(bare).sort()).toEqual(
			["channel_id", "event_id", "expires_at", "kind", "pk", "seq", "sk", "tenant_id", "turn_id"].sort(),
		);
	});

	it("encodes a pending computer tool with sorted keys", () => {
		const tool = { actionId: "a", toolName: "t", arguments: { z: "1", a: "2" } };
		expect(encodePendingComputerTool(tool)).toBe('{"action_id":"a","arguments":{"a":"2","z":"1"},"tool_name":"t"}');
		expect(decodePendingComputerTool(encodePendingComputerTool(tool))).toEqual(tool);
	});
});
