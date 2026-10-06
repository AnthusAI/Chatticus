import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, describe, expect, it } from "vitest";
import {
	ACTION_LEASE_SECONDS,
	type ActionDependencies,
	claimNextComputerAction,
	completeComputerAction,
	ComputerActionNotClaimedError,
	envelopeForCall,
	expireLostComputerActions,
	gateForComputerTool,
	INTERRUPTED_ACTION_RESULT,
	requestComputerAction,
} from "../src/domain/actions.ts";
import { DynamoComputerActionStore } from "../src/store/action-store.ts";
import { decodeAction, encodeAction, encodeActionIndex } from "../src/store/codecs/action.ts";

const client = new DynamoDBClient({
	endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
	region: "us-east-1",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
	maxAttempts: 1,
});
const tableName = `computer-actions-${randomUUID()}`;
let created = false;

async function dependencies(now: { value: Date }): Promise<ActionDependencies> {
	if (!created) {
		await client.send(
			new CreateTableCommand({
				TableName: tableName,
				KeySchema: [
					{ AttributeName: "pk", KeyType: "HASH" },
					{ AttributeName: "sk", KeyType: "RANGE" },
				],
				AttributeDefinitions: [
					{ AttributeName: "pk", AttributeType: "S" },
					{ AttributeName: "sk", AttributeType: "S" },
				],
				BillingMode: "PAY_PER_REQUEST",
			}),
		);
		created = true;
	}
	let next = 0;
	return {
		actions: new DynamoComputerActionStore(client, tableName),
		clock: { now: () => now.value },
		ids: { next: () => `id-${(next += 1)}` },
	};
}

afterAll(async () => {
	if (created) await client.send(new DeleteTableCommand({ TableName: tableName }));
	client.destroy();
});

const request = (tenantId: string, turnId: string, callId: string, toolName = "write_workspace") => ({
	tenantId,
	computerId: "computer-1",
	turnId,
	channelId: "channel-1",
	botId: "bot-1",
	userId: "ryan",
	callId,
	toolName,
	arguments: (toolName === "write_workspace" ? { path: "/workspace/a.txt", content: "x" } : { path: "/workspace/a.txt" }) as Record<string, string>,
});

describe("computer action helpers", () => {
	it("maps the browser tools to the browser gate and everything else to the workspace gate", () => {
		expect(gateForComputerTool("browse")).toBe("browser");
		expect(gateForComputerTool("request_computer_capability")).toBe("browser");
		expect(gateForComputerTool("read_workspace")).toBe("workspace");
		expect(gateForComputerTool("run_terminal")).toBe("workspace");
	});

	it("marks reads, page loads and capability requests as safe to run twice and the rest as not", () => {
		expect(envelopeForCall("read_workspace", { path: "/workspace/a" }).idempotent).toBe(true);
		expect(envelopeForCall("browse", { url: "https://a.example.com" })).toMatchObject({ idempotent: true, origin: "https://a.example.com" });
		expect(envelopeForCall("write_workspace", { path: "/workspace/a" }).idempotent).toBe(false);
		expect(envelopeForCall("run_terminal", { command: "ls" })).toMatchObject({ idempotent: false, cwd: "/workspace" });
	});

	it("round-trips an action and keys its index item by the Pi call id", async () => {
		const now = { value: new Date("2026-10-06T00:00:00Z") };
		const action = await requestComputerAction(await dependencies(now), request("t-codec", "turn-1", "call-9"));
		expect(decodeAction(encodeAction(action))).toEqual(action);
		expect(encodeActionIndex(action).pk).toEqual({ S: "t-codec#turn#turn-1" });
		expect(encodeActionIndex(action).sk).toEqual({ S: "act#call-9" });
		expect(encodeAction(action).pk).toEqual({ S: "t-codec#computer#actions" });
	});
});

describe("computer actions in the Messaging table", () => {
	it("creates one action per call id however often the call is asked for", async () => {
		const deps = await dependencies({ value: new Date("2026-10-06T00:00:00Z") });
		const first = await requestComputerAction(deps, request("t-once", "turn-1", "call-1"));
		const second = await requestComputerAction(deps, request("t-once", "turn-1", "call-1"));
		const other = await requestComputerAction(deps, request("t-once", "turn-1", "call-2"));
		expect(second.actionId).toBe(first.actionId);
		expect(other.actionId).not.toBe(first.actionId);
		expect((await deps.actions.listForTurn("t-once", "turn-1")).map((action) => action.callId)).toEqual(["call-1", "call-2"]);
		expect((await deps.actions.getByCall("t-once", "turn-1", "call-1"))?.actionId).toBe(first.actionId);
		expect(await deps.actions.getByCall("t-once", "turn-2", "call-1")).toBeNull();
	});

	it("hands an action to one host at a time and lets the holder ask again", async () => {
		const now = { value: new Date("2026-10-06T00:00:00Z") };
		const deps = await dependencies(now);
		const action = await requestComputerAction(deps, request("t-claim", "turn-1", "call-1"));
		const [first, second] = await Promise.all([claimNextComputerAction(deps, "t-claim", "host-a"), claimNextComputerAction(deps, "t-claim", "host-b")]);
		expect([first, second].filter((claimed) => claimed !== null)).toHaveLength(1);
		const holder = first !== null ? "host-a" : "host-b";
		const other = first !== null ? "host-b" : "host-a";
		expect((await claimNextComputerAction(deps, "t-claim", holder))?.actionId).toBe(action.actionId);
		expect(await claimNextComputerAction(deps, "t-claim", other)).toBeNull();
		await expect(completeComputerAction(deps, "t-claim", action.actionId, other, { result: "x", isError: false })).rejects.toBeInstanceOf(
			ComputerActionNotClaimedError,
		);
	});

	it("keeps the first answer and ignores a repeated one", async () => {
		const deps = await dependencies({ value: new Date("2026-10-06T00:00:00Z") });
		const action = await requestComputerAction(deps, request("t-answer", "turn-1", "call-1"));
		await claimNextComputerAction(deps, "t-answer", "host-a");
		const answered = await completeComputerAction(deps, "t-answer", action.actionId, "host-a", { result: "first", isError: false });
		expect(answered.recorded).toBe(true);
		const again = await completeComputerAction(deps, "t-answer", action.actionId, "host-a", { result: "second", isError: true });
		expect(again.recorded).toBe(false);
		expect(again.action.result).toBe("first");
		expect(again.action.resultIsError).toBe(false);
		expect(await deps.actions.listOpen("t-answer")).toEqual([]);
	});

	it("settles a lost host: a safe action goes back to requested, an unsafe one is answered as interrupted", async () => {
		const now = { value: new Date("2026-10-06T00:00:00Z") };
		const deps = await dependencies(now);
		const read = await requestComputerAction(deps, request("t-lost", "turn-1", "call-1", "read_workspace"));
		const write = await requestComputerAction(deps, request("t-lost", "turn-2", "call-1", "write_workspace"));
		await claimNextComputerAction(deps, "t-lost", "host-a");
		now.value = new Date(now.value.getTime() + (ACTION_LEASE_SECONDS - 1) * 1000);
		expect(await expireLostComputerActions(deps, "t-lost")).toEqual([]);
		now.value = new Date(now.value.getTime() + 2 * 1000);
		const released = await expireLostComputerActions(deps, "t-lost");
		expect(released.map((action) => [action.actionId, action.status])).toEqual([[read.actionId, "requested"]]);
		expect((await claimNextComputerAction(deps, "t-lost", "host-b"))?.actionId).toBe(read.actionId);
		await completeComputerAction(deps, "t-lost", read.actionId, "host-b", { result: "r", isError: false });
		await claimNextComputerAction(deps, "t-lost", "host-b");
		now.value = new Date(now.value.getTime() + (ACTION_LEASE_SECONDS + 1) * 1000);
		const settled = await expireLostComputerActions(deps, "t-lost");
		expect(settled.map((action) => [action.actionId, action.status])).toEqual([[write.actionId, "done"]]);
		expect(settled[0]!.result).toBe(INTERRUPTED_ACTION_RESULT);
		expect(settled[0]!.resultIsError).toBe(true);
	});
});
