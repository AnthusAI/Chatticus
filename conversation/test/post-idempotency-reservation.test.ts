import { describe, expect, it } from "vitest";
import {
	ConditionalCheckFailedException,
	GetItemCommand,
	PutItemCommand,
	UpdateItemCommand,
	type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";

type Item = Record<string, AttributeValue>;

function dynamoHarness() {
	const items = new Map<string, Item>();
	const keyOf = (pk: string, sk: string) => `${pk}\u0000${sk}`;
	const conditionalFailure = () => new ConditionalCheckFailedException({
		message: "conditional request failed", $metadata: {},
	});
	const client = {
		async send(command: any): Promise<any> {
			const input: any = command.input;
			if (command instanceof PutItemCommand) {
				const item = input.Item as Item;
				const key = keyOf(item.pk.S!, item.sk.S!);
				if (items.has(key)) throw conditionalFailure();
				items.set(key, structuredClone(item));
				return {};
			}
			if (command instanceof GetItemCommand) {
				const { pk, sk } = input.Key;
				const item = items.get(keyOf(pk.S!, sk.S!));
				return item === undefined ? {} : { Item: structuredClone(item) };
			}
			if (command instanceof UpdateItemCommand) {
				const { pk, sk } = input.Key;
				const key = keyOf(pk.S!, sk.S!);
				const item = items.get(key);
				if (item === undefined) throw conditionalFailure();
				const values = input.ExpressionAttributeValues;
				if (input.UpdateExpression.startsWith("SET reservation_owner")) {
					if (item.reservation_state?.S !== "pending" || item.request_fingerprint?.S !== values[":fingerprint"].S || Number(item.lease_expires_at?.N) > Number(values[":now"].N)) throw conditionalFailure();
					item.reservation_owner = values[":owner"];
					item.lease_expires_at = values[":lease"];
					return { Attributes: structuredClone(item) };
				}
				if (input.UpdateExpression.includes("if_not_exists")) {
					if (item.reservation_state?.S !== "pending" || item.reservation_owner?.S !== values[":owner"].S || Number(item.lease_expires_at?.N) <= Number(values[":now"].N)) throw conditionalFailure();
					item.seq ??= values[":seq"];
					return { Attributes: structuredClone(item) };
				}
				if (item.reservation_state?.S !== "pending" || item.reservation_owner?.S !== values[":owner"].S || Number(item.lease_expires_at?.N) <= Number(values[":now"].N)) throw conditionalFailure();
				item.reservation_state = values[":complete"];
				item.channel_id = values[":channel"];
				item.message_id = values[":message"];
				item.seq = values[":seq"];
				item.author_kind = values[":author_kind"];
				item.author_id = values[":author_id"];
				item.body = values[":body"];
				item.addressed_to_bot_id = values[":addressed"];
				item.created_at = values[":created"];
				if (values[":turn"] === undefined) delete item.turn_id;
				else item.turn_id = values[":turn"];
				return {};
			}
			throw new Error(`unexpected command ${command.constructor.name}`);
		},
	};
	return { client, items };
}

describe("DynamoMessagingStore post idempotency reservations", () => {
	it("conditionally reserves once, completes, and replays the durable result", async () => {
		const { client } = dynamoHarness();
		const store = new DynamoMessagingStore(client as never, "test-table");
		const now = new Date("2026-01-01T00:00:00.000Z");
		const candidate = (ownerId: string) => ({ ownerId, messageId: "message-1", createdAt: now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
		const [first, concurrent] = await Promise.all([
			store.reservePostIdempotency("tenant", "request", "fingerprint", candidate("owner-a"), now),
			store.reservePostIdempotency("tenant", "request", "fingerprint", candidate("owner-b"), now),
		]);
		expect([first.state, concurrent.state].sort()).toEqual(["busy", "owner"]);
		const owner = first.state === "owner" ? first.reservation : concurrent.state === "owner" ? concurrent.reservation : null;
		expect(owner).not.toBeNull();
		const seq = await store.setPostIdempotencySequence("tenant", "request", owner!.ownerId, 7, now);
		expect(seq).toBe(7);
		const completed = await store.completePostIdempotency("tenant", "request", owner!.ownerId, {
			messageId: "message-1", channelId: "channel", tenantId: "tenant", seq: 7,
			authorKind: "human", authorId: "editor", body: "Hello", addressedToBotId: null, createdAt: now,
		}, null, now);
		expect(completed).toBe(true);
		const replay = await store.reservePostIdempotency("tenant", "request", "fingerprint", candidate("owner-c"), now);
		expect(replay.state).toBe("completed");
		if (replay.state === "completed") expect(replay.result.message).toMatchObject({ messageId: "message-1", seq: 7, body: "Hello" });
		const conflict = await store.reservePostIdempotency("tenant", "request", "other-fingerprint", candidate("owner-d"), now);
		expect(conflict.state).toBe("conflict");
	});

	it("reclaims an expired reservation and preserves its recorded sequence", async () => {
		const { client } = dynamoHarness();
		const store = new DynamoMessagingStore(client as never, "test-table");
		const now = new Date("2026-01-01T00:00:00.000Z");
		const old = new Date(now.getTime() - 60_000);
		const created = await store.reservePostIdempotency("tenant", "request", "fingerprint", {
			ownerId: "dead-owner", messageId: "stable-message", createdAt: old, leaseExpiresAt: new Date(now.getTime() - 30_000),
		}, old);
		expect(created.state).toBe("owner");
		if (created.state !== "owner") throw new Error("reservation was not created");
		expect(await store.setPostIdempotencySequence("tenant", "request", created.reservation.ownerId, 12, old)).toBe(12);
		const recovered = await store.reservePostIdempotency("tenant", "request", "fingerprint", {
			ownerId: "recovery-owner", messageId: "ignored-candidate", createdAt: now, leaseExpiresAt: new Date(now.getTime() + 30_000),
		}, now);
		expect(recovered.state).toBe("owner");
		if (recovered.state === "owner") expect(recovered.reservation).toMatchObject({ ownerId: "recovery-owner", messageId: "stable-message", seq: 12 });
	});
});
