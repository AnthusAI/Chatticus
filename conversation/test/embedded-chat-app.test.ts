import { describe, expect, it } from "vitest";
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { InMemoryMessagingStore } from "../features-support/in-memory-messaging-store.ts";
import { createEmbeddedChatApp } from "../src/http/embedded-chat-app.ts";
import type { MessageDependencies } from "../src/domain/messages.ts";
import type { Principal } from "../src/auth/principal.ts";

const now = new Date("2026-01-01T00:00:00.000Z");

function fakeDynamo() {
	const items = new Map<string, Record<string, { S?: string; N?: string }>>();
	const sequences = new Map<string, number>();
	return {
		items,
		client: {
			async send(command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
				if (command instanceof UpdateItemCommand) {
					const pk = command.input.Key?.pk?.S ?? "";
					const next = (sequences.get(pk) ?? 1) + 1;
					sequences.set(pk, next);
					return { Attributes: { next_seq: { N: String(next) } } };
				}
				if (command instanceof PutItemCommand) {
					const item = command.input.Item as Record<string, { S?: string; N?: string }>;
					items.set(`${item.pk?.S}\u0000${item.sk?.S}`, item);
					return {};
				}
				if (command instanceof QueryCommand) {
					const pk = command.input.ExpressionAttributeValues?.[":pk"]?.S;
					if (!pk?.startsWith("MB#")) return { Items: [] };
					return {
						Items: [...items.values()]
							.filter((item) => item.pk?.S === pk)
							.sort((left, right) => (left.sk?.S ?? "").localeCompare(right.sk?.S ?? "")),
					};
				}
				if (command instanceof GetItemCommand) return {};
				throw new Error(`Unexpected test DynamoDB command: ${command.constructor.name}`);
			},
		},
	};
}

function setup() {
	const store = new InMemoryMessagingStore();
	const dynamo = fakeDynamo();
	let id = 0;
	const tenantId = "site-account-editor-a";
	const editorId = "prospectus-person-a";
	const channelId = "private-channel-a";
	void store.putChannel({
		channelId,
		tenantId,
		kind: "direct",
		name: null,
		participants: [
			{ kind: "human", actorId: editorId },
			{ kind: "bot", actorId: "editorial-assistant" },
		],
		nextSeq: 1,
	});
	const principal: Principal = {
		kind: "user",
		tenantId,
		userId: editorId,
		workerId: null,
		organizationStatus: "enabled",
		role: "member",
	};
	const messages: MessageDependencies = {
		store,
		ids: { next: () => `generated-${++id}` },
		clock: { now: () => now },
		mailbox: { client: dynamo.client as never, tableName: "test" },
		turns: { async openTurn() { return null; }, async startTurn() { return false; }, async steerTurn() { return false; }, async recordLogicalEnqueue() { return true; } },
		turnRuns: { async enqueue() {} },
		turnProbes: { async send() {} },
		listing: {
			client: dynamo.client as never,
			s3: {} as never,
			messagingTableName: "test",
			conversationsTableName: "test",
			bucket: "test",
		},
	};
	const app = createEmbeddedChatApp({
		clock: { now: () => now },
		messages,
		turns: { store: {} as never, clock: { now: () => now }, ids: { next: () => `turn-${++id}` } },
		resolvePrincipal: async (request) => request.headers.get("x-test-editor") === editorId ? principal : null,
	});
	return { app, channelId, editorId, tenantId, store };
}

describe("embedded chat server core", () => {
	it("sends, reads and replays through the real message domain with host-derived private scope", async () => {
		const { app, channelId, editorId, store } = setup();
		const post = () => app.request(`/channels/${channelId}/messages?tenant_id=attacker-selected`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId, "idempotency-key": "attempt-1" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "A newsroom message", addressed_to_bot_id: null }),
		});
		const first = await post();
		expect(first.status).toBe(200);
		const firstBody = await first.json() as { message: { message_id: string; tenant_id: string; body: string } };
		expect(firstBody.message.tenant_id).toBe("site-account-editor-a");
		expect(firstBody.message.body).toBe("A newsroom message");
		const replay = await post();
		const replayBody = await replay.json() as { message: { message_id: string } };
		expect(replayBody.message.message_id).toBe(firstBody.message.message_id);
		const conflict = await app.request(`/channels/${channelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId, "idempotency-key": "attempt-1" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "Changed payload", addressed_to_bot_id: null }),
		});
		expect(conflict.status).toBe(409);
		const secondChannelId = "private-channel-b";
		await store.putChannel({
			channelId: secondChannelId,
			tenantId: "site-account-editor-a",
			kind: "direct",
			name: null,
			participants: [
				{ kind: "human", actorId: editorId },
				{ kind: "bot", actorId: "editorial-assistant" },
			],
			nextSeq: 1,
		});
		const otherChannel = await app.request(`/channels/${secondChannelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId, "idempotency-key": "attempt-1" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "Same key, separate channel", addressed_to_bot_id: null }),
		});
		expect(otherChannel.status).toBe(200);
		const otherChannelBody = await otherChannel.json() as { message: { message_id: string; channel_id: string } };
		expect(otherChannelBody.message).toMatchObject({ channel_id: secondChannelId });
		expect(otherChannelBody.message.message_id).not.toBe(firstBody.message.message_id);
		const read = await app.request(`/channels/${channelId}/messages`, { headers: { "x-test-editor": editorId } });
		expect(read.status).toBe(200);
		const readBody = await read.json() as { messages: Array<{ message_id: string; body: string }> };
		expect(readBody.messages).toHaveLength(1);
		expect(readBody.messages[0]).toMatchObject({ message_id: firstBody.message.message_id, body: "A newsroom message" });
	});

	it("rejects missing host identity, browser-claimed author and foreign private transcript reads", async () => {
		const { app, channelId, editorId } = setup();
		const missing = await app.request(`/channels/${channelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "No identity", addressed_to_bot_id: null }),
		});
		expect(missing.status).toBe(401);
		const impersonation = await app.request(`/channels/${channelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId },
			body: JSON.stringify({ author_kind: "human", author_id: "other-editor", body: "Impersonation", addressed_to_bot_id: null }),
		});
		expect(impersonation.status).toBe(403);
		const foreignRead = await app.request(`/channels/${channelId}/messages`, {
			headers: { "x-test-editor": "site-person-editor-b" },
		});
		expect(foreignRead.status).toBe(401);
	});
});
