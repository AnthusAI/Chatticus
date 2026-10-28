import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { InMemoryMessagingStore } from "../features-support/in-memory-messaging-store.ts";
import { createEmbeddedChatApp } from "../src/http/embedded-chat-app.ts";
import type { MessageDependencies } from "../src/domain/messages.ts";
import type { Principal } from "../src/auth/principal.ts";
import type { Turn } from "../src/domain/turns.ts";
import type { TurnAdmission, TurnRunQueue } from "../src/domain/turn-admission.ts";
import type { TurnProbeMessage, TurnProbeQueue } from "../src/domain/turn-admission.ts";

const now = new Date("2026-01-01T00:00:00.000Z");

function fakeDynamo() {
	const items = new Map<string, Record<string, { S?: string; N?: string }>>();
	const sequences = new Map<string, number>();
	return {
		items,
		sequences,
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
	let currentTime = now;
	const probes: TurnProbeMessage[] = [];
	const sideEffectOrder: string[] = [];
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
	const turn: Turn = {
		turnId: "turn-private-a", tenantId, channelId, botId: "editorial-assistant", status: "completed",
		promptMessageSeq: null, promptAuthorId: editorId, attemptId: null, attempt: 0, claimedBy: null,
		leaseExpiresAt: null, deadlineAt: null, recoveryAttempts: 0, waitingFor: null, waitingSince: null,
		logicalEnqueueIds: [], pendingComputerTool: null, storageFence: null, nextEventSeq: 1, terminalReason: null, messageSeq: null,
	};
	const turnAdmission: TurnAdmission = {
		async openTurn() { return null; },
		async startTurn() { return false; },
		async steerTurn() { return false; },
		async recordLogicalEnqueue() { return true; },
	};
	const turnRuns: TurnRunQueue = { async enqueue() {} };
	const messages: MessageDependencies = {
		store,
		ids: { next: () => `generated-${++id}` },
		clock: { now: () => currentTime },
		mailbox: { client: dynamo.client as never, tableName: "test" },
		turns: turnAdmission,
		turnRuns,
		turnProbes: { async send(message) { probes.push(message); sideEffectOrder.push("probe"); } } satisfies TurnProbeQueue,
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
		turns: {
			store: { async getTurn(scope: string, requestedId: string) { return scope === tenantId && requestedId === turn.turnId ? turn : null; }, async listEvents() { return []; } } as never,
			clock: { now: () => now }, ids: { next: () => `turn-${++id}` },
		},
		resolvePrincipal: async (request) => {
			const identity = request.headers.get("x-test-editor");
			if (identity === editorId) return principal;
			if (identity === "same-tenant-nonparticipant") return { ...principal, userId: identity };
			if (identity === "editor-b") return { ...principal, tenantId: `${tenantId}-other`, userId: identity };
			return null;
		},
	});
	return { app, channelId, editorId, tenantId, store, turnAdmission, turnRuns, messages, probes, sideEffectOrder, setTime(value: Date) { currentTime = value; }, turnId: turn.turnId };
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

	it("atomically collapses concurrent identical sends and rejects enqueue flag conflicts", async () => {
		const { app, channelId, editorId } = setup();
		const send = (enqueueTurn: boolean) => app.request(`/channels/${channelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId, "idempotency-key": "concurrent-key" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "Concurrent message", addressed_to_bot_id: null, enqueue_turn: enqueueTurn }),
		});
		const [left, right] = await Promise.all([send(true), send(true)]);
		expect(left.status).toBe(200);
		expect(right.status).toBe(200);
		const [leftBody, rightBody] = await Promise.all([
			left.json() as Promise<{ message: { message_id: string } }>,
			right.json() as Promise<{ message: { message_id: string } }>,
		]);
		expect(leftBody.message.message_id).toBe(rightBody.message.message_id);
		const conflict = await send(false);
		expect(conflict.status).toBe(409);
	});

	it("recovers an expired interrupted reservation using its stable message id and sequence", async () => {
		const { app, channelId, editorId, tenantId, store } = setup();
		const key = createHash("sha256").update(JSON.stringify([tenantId, channelId, "human", editorId, "recovery-key"])).digest("hex");
		const fingerprint = createHash("sha256").update(JSON.stringify([tenantId, channelId, "human", editorId, "Recovered message", null, true])).digest("hex");
		const createdAt = new Date(now.getTime() - 60_000);
		const initial = await store.reservePostIdempotency(tenantId, key, fingerprint, {
			ownerId: "interrupted-owner", messageId: "stable-recovery-message", createdAt,
			leaseExpiresAt: new Date(now.getTime() - 30_000),
			reservedTurnId: null, startedEventId: null,
		}, new Date(now.getTime() - 60_000));
		expect(initial.state).toBe("owner");
		if (initial.state !== "owner") throw new Error("test reservation was not acquired");
		await store.setPostIdempotencySequence(tenantId, key, initial.reservation.ownerId, 42, new Date(now.getTime() - 45_000));
		const response = await app.request(`/channels/${channelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId, "idempotency-key": "recovery-key" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "Recovered message", addressed_to_bot_id: null }),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as { message: { message_id: string; seq: number } };
		expect(body.message).toMatchObject({ message_id: "stable-recovery-message", seq: 42 });
	});

	it("reuses the committed turn and fences stale owners after enqueue-before-completion interruption", async () => {
		const { app, channelId, editorId, tenantId, store, turnAdmission, turnRuns, probes, sideEffectOrder, setTime } = setup();
		const turns = new Map<string, { active: boolean }>();
		const enqueued = new Set<string>();
		const jobs: string[] = [];
		let pointerTurnId: string | null = null;
		let starts = 0;
		let staleFence: { tenantId: string; idempotencyKey: string; ownerId: string; now: Date } | null = null;
		let staleStartRequest: any;
		turnAdmission.openTurn = async () => pointerTurnId === null ? null : {
			pointerTurnId, active: turns.get(pointerTurnId)?.active ?? false, closing: false,
		};
		turnAdmission.startTurn = async (request: any) => {
			sideEffectOrder.push("turn-start");
			staleStartRequest = request;
			if (request.reservationFence !== undefined) {
				staleFence = request.reservationFence;
				const accepted = await store.recordPostIdempotencyAdmission(
					request.reservationFence.tenantId,
					request.reservationFence.idempotencyKey,
					request.reservationFence.ownerId,
					{ turnId: request.turnId, kind: "started" },
					request.reservationFence.now,
				);
				if (!accepted) throw new Error("stale reservation owner");
			}
			if (turns.has(request.turnId)) return false;
			turns.set(request.turnId, { active: true });
			pointerTurnId = request.turnId;
			starts += 1;
			return true;
		};
		turnAdmission.recordLogicalEnqueue = async (_tenant: string, turnId: string, enqueueId: string, fence?: { tenantId: string; idempotencyKey: string; ownerId: string; now: Date }) => {
			if (fence !== undefined) {
				const reservation = await store.setPostIdempotencySequence(fence.tenantId, fence.idempotencyKey, fence.ownerId, 1, fence.now);
				if (reservation === null) throw new Error("stale reservation owner cannot enqueue");
			}
			if (enqueued.has(enqueueId)) return false;
			enqueued.add(enqueueId);
			return true;
		};
		turnRuns.enqueue = async (job: { turnId: string }) => { jobs.push(job.turnId); };
		const complete = store.completePostIdempotency.bind(store);
		let interruptAfterEnqueue = true;
		store.completePostIdempotency = async (...args: Parameters<typeof complete>) => {
			if (interruptAfterEnqueue) {
				interruptAfterEnqueue = false;
				throw new Error("injected interruption after queue enqueue");
			}
			return complete(...args);
		};
		const send = () => app.request(`/channels/${channelId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-test-editor": editorId, "idempotency-key": "start-and-enqueue" },
			body: JSON.stringify({ author_kind: "human", author_id: editorId, body: "Run once", addressed_to_bot_id: "editorial-assistant" }),
		});
		try { await send(); } catch { /* The injected failure models a crash after enqueue and before reservation completion. */ }
		expect(starts).toBe(1);
		expect(jobs).toHaveLength(1);
		expect(probes).toHaveLength(1);
		expect(probes[0]).toMatchObject({ turnId: jobs[0], kind: "deadline" });
		expect(sideEffectOrder.indexOf("probe")).toBeLessThan(sideEffectOrder.indexOf("turn-start"));
		const originalTurnId = jobs[0];
		turns.get(originalTurnId!)!.active = false;
		setTime(new Date(now.getTime() + 31_000));
		const retry = await send();
		expect(retry.status).toBe(200);
		const retryBody = await retry.json() as { turn_id: string };
		expect(retryBody.turn_id).toBe(originalTurnId);
		expect(starts).toBe(1);
		expect(jobs).toEqual([originalTurnId]);
		const staleFenceCopy = { ...staleFence! };
		await expect(turnAdmission.startTurn(staleStartRequest)).rejects.toThrow("stale reservation owner");
		const staleEnqueue = await store.setPostIdempotencySequence(tenantId, staleFenceCopy.idempotencyKey, staleFenceCopy.ownerId, 1, now);
		expect(staleEnqueue).toBeNull();
		expect(starts).toBe(1);
		expect(jobs).toHaveLength(1);
	});

	it("uses host scope and participant membership for turn events and streams", async () => {
		const { app, editorId, turnId } = setup();
		for (const endpoint of [`/turns/${turnId}/events`, `/turns/${turnId}/stream`]) {
			const own = await app.request(endpoint, { headers: { "x-test-editor": editorId } });
			expect(own.status).toBe(200);
			const sameTenantNonparticipant = await app.request(endpoint, { headers: { "x-test-editor": "same-tenant-nonparticipant" } });
			expect(sameTenantNonparticipant.status).toBe(403);
			const otherTenant = await app.request(endpoint, { headers: { "x-test-editor": "editor-b" } });
			expect(otherTenant.status).toBe(403);
		}
	});
});
