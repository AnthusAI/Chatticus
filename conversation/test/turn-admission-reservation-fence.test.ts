import { describe, expect, it } from "vitest";
import {
	GetItemCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoTurnAdmission } from "../src/store/turn-admission-store.ts";

describe("DynamoTurnAdmission reservation fencing", () => {
	it("commits the turn mailbox and admission outcome with the owner fence, and blocks a reclaimed owner", async () => {
		let reservationOwner = "new-owner";
	const now = new Date("2026-01-01T00:00:00.000Z");
		const transactions: any[][] = [];
		const client = {
			async send(command: any): Promise<any> {
				if (command instanceof TransactWriteItemsCommand) {
					const items = command.input.TransactItems ?? [];
					transactions.push(items);
					const fencedItem = items.find((item: any) =>
						item.Update?.UpdateExpression?.includes("admitted_turn_id") ||
						item.ConditionCheck?.ConditionExpression?.includes("reservation_owner"),
					);
					const owner = fencedItem?.Update?.ExpressionAttributeValues?.[":owner"]?.S ??
						fencedItem?.ConditionCheck?.ExpressionAttributeValues?.[":owner"]?.S;
					if (owner !== undefined && owner !== reservationOwner) {
						throw new TransactionCanceledException({ message: "reservation owner changed", $metadata: {} });
					}
					return {};
				}
				if (command instanceof GetItemCommand) {
					const pk = command.input.Key?.pk?.S;
					if (pk === "tenant#roster") {
						return { Item: { reservation_state: { S: "pending" }, reservation_owner: { S: reservationOwner }, lease_expires_at: { N: String(now.getTime() + 30_000) } } };
					}
					return { Item: { logical_enqueue_ids: { SS: [] } } };
				}
				throw new Error(`unexpected command ${command.constructor.name}`);
			},
		};
		const admission = new DynamoTurnAdmission(client as never, "test-table");
		const item = {
			tenantId: "tenant", botId: "bot", channelId: "channel", seq: 1, messageId: "message",
			authorKind: "human", authorId: "editor", addressedToBotId: "bot", body: "hello", createdAt: now.toISOString(),
		};
		const request = {
			tenantId: "tenant", channelId: "channel", botId: "bot", turnId: "stable-turn",
			promptMessageSeq: 1, promptAuthorId: "editor", grant: null, createdAt: now,
			startedEventId: "stable-started-event", expectedPointerTurnId: null, initialItem: item,
			reservationFence: { tenantId: "tenant", idempotencyKey: "request-hash", ownerId: "old-owner", now },
		};
		await expect(admission.startTurn(request)).rejects.toThrow("no longer owned");
		const staleTransaction = transactions[0]!;
		expect(staleTransaction.some((entry) => entry.Put?.Item?.message_id?.S === "message")).toBe(true);
		expect(staleTransaction.some((entry) => entry.Update?.UpdateExpression?.includes("admitted_turn_id"))).toBe(true);
		const staleJob = () => admission.recordLogicalEnqueue("tenant", "stable-turn", "stable-turn#initial", request.reservationFence);
		await expect(staleJob()).rejects.toThrow("no longer owned");
		expect(transactions[1]?.some((entry) => entry.ConditionCheck?.ConditionExpression?.includes("reservation_owner"))).toBe(true);
		reservationOwner = "new-owner";
		const currentRequest = { ...request, reservationFence: { ...request.reservationFence, ownerId: reservationOwner } };
		expect(await admission.startTurn(currentRequest)).toBe(true);
	});
});
