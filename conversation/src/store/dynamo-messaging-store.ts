/**
 * Production MessagingStore over the Messaging DynamoDB table.
 * Ported from python/src/chatticus/messaging/store.py DynamoMessagingStore (lines 1123-2377, 2723-2812).
 */

import {
	ConditionalCheckFailedException,
	DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	ScanCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
	UpdateItemCommand,
	type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { ActorKind, Channel, ChannelMessageRecord } from "../domain/channels.ts";
import type {
	Identity,
	Invitation,
	Membership,
	Organization,
	OrganizationStatus,
} from "../domain/organizations.ts";
import { Decimal } from "../budget/decimal.ts";
import { DuplicateBotNameError } from "../http/errors.ts";
import * as botCodec from "./codecs/bot.ts";
import type { Bot } from "./codecs/bot.ts";
import * as channelCodec from "./codecs/channel.ts";
import * as computerCodec from "./codecs/computer.ts";
import type { Computer } from "./codecs/computer.ts";
import * as idempotencyCodec from "./codecs/idempotency.ts";
import * as identityCodec from "./codecs/identity.ts";
import * as invitationCodec from "./codecs/invitation.ts";
import * as membershipCodec from "./codecs/membership.ts";
import * as organizationCodec from "./codecs/organization.ts";
import * as taskCodec from "./codecs/task.ts";
import type { Task } from "./codecs/task.ts";
import { formatIsoDateTime } from "./codecs/util.ts";
import * as workerCodec from "./codecs/worker.ts";
import type { Worker } from "./codecs/worker.ts";
import { postIdempotencyKey } from "./keys.ts";
import type { MessagingStore } from "./messaging-store.ts";

type Item = Record<string, AttributeValue>;

const ONE_HOUR_SECONDS = 3600;

function rosterPartition(tenantId: string): string {
	return `${tenantId}#roster`;
}

function organizationPartition(tenantId: string): string {
	return `${tenantId}#org`;
}

function userPartition(userId: string): string {
	return `user#${userId}`;
}

function channelPartition(tenantId: string, channelId: string): string {
	return `${tenantId}#channel#${channelId}`;
}

/** MessagingStore backed by one DynamoDB table with string pk and sk and a TTL on expires_at. */
export class DynamoMessagingStore implements MessagingStore {
	private readonly client: DynamoDBClient;
	private readonly tableName: string;
	private readonly queryPageLimit: number | undefined;

	/**
	 * @param client DynamoDB client.
	 * @param tableName Messaging table name.
	 * @param queryPageLimit Optional cap on items evaluated per Query or Scan page, so tests can exercise pagination.
	 */
	constructor(client: DynamoDBClient, tableName: string, queryPageLimit?: number) {
		this.client = client;
		this.tableName = tableName;
		this.queryPageLimit = queryPageLimit;
	}

	async getIdentityByEmail(email: string): Promise<Identity | null> {
		const lookup = await this.get(`identity_lookup#${email}`, "meta");
		if (lookup === null) {
			return null;
		}
		const item = await this.get(userPartition(lookup.user_id?.S ?? ""), "identity");
		return item === null ? null : identityCodec.decode(item);
	}

	async putIdentity(identity: Identity): Promise<void> {
		await this.put(identityCodec.encode(identity));
		await this.put({
			pk: { S: `identity_lookup#${identity.email}` },
			sk: { S: "meta" },
			user_id: { S: identity.userId },
			email: { S: identity.email },
			created_at: { S: formatIsoDateTime(identity.createdAt) },
		});
	}

	async getOrganization(tenantId: string): Promise<Organization | null> {
		const item = await this.get(organizationPartition(tenantId), "meta");
		return item === null ? null : this.organizationFromItem(item);
	}

	async putOrganization(organization: Organization): Promise<void> {
		await this.put(
			organizationCodec.encode({
				tenantId: organization.tenantId,
				name: organization.name,
				status: organization.status,
				ownerUserId: organization.ownerUserId,
				createdAt: organization.createdAt,
				awsAccountId: organization.awsAccountId ?? undefined,
				awsCrossAccountRole: organization.awsCrossAccountRole ?? undefined,
				awsExternalId: organization.awsExternalId ?? undefined,
				awsSetupPath: organization.awsSetupPath ?? undefined,
				setupFeeCents: organization.setupFeeCents ?? undefined,
				assistedSetupSession: organization.assistedSetupSession,
				monthlyAwsSpendCeilingUsd:
					organization.monthlyAwsSpendCeilingUsd === null ? undefined : organization.monthlyAwsSpendCeilingUsd.toString(),
			}),
		);
	}

	async getMembership(tenantId: string, userId: string): Promise<Membership | null> {
		const item = await this.get(organizationPartition(tenantId), `member#${userId}`);
		return item === null ? null : this.membershipFromItem(item);
	}

	async putMembership(membership: Membership): Promise<void> {
		await this.put(membershipCodec.encode(membership));
		await this.put({
			pk: { S: userPartition(membership.userId) },
			sk: { S: `org#${membership.tenantId}` },
			tenant_id: { S: membership.tenantId },
			user_id: { S: membership.userId },
			role: { S: membership.role },
		});
	}

	async listMemberships(tenantId: string): Promise<Membership[]> {
		const items = await this.queryPrefix(organizationPartition(tenantId), "member#");
		return items.map((item) => this.membershipFromItem(item)).sort((left, right) => compareStrings(left.userId, right.userId));
	}

	async getInvitation(invitationId: string): Promise<Invitation | null> {
		const lookup = await this.get(`invitation_lookup#${invitationId}`, "meta");
		if (lookup === null) {
			return null;
		}
		const canonical = await this.get(organizationPartition(lookup.tenant_id?.S ?? ""), `invite#${invitationId}`);
		return canonical === null ? null : this.invitationFromItem(canonical);
	}

	async putInvitation(invitation: Invitation): Promise<void> {
		await this.put(invitationCodec.encode(invitation));
		await this.put({
			pk: { S: `invitation_lookup#${invitation.invitationId}` },
			sk: { S: "meta" },
			tenant_id: { S: invitation.tenantId },
			invitation_id: { S: invitation.invitationId },
		});
		await this.put({
			pk: { S: `invitation_email#${invitation.email}` },
			sk: { S: `pending#${invitation.invitationId}` },
			invitation_id: { S: invitation.invitationId },
			tenant_id: { S: invitation.tenantId },
			expires_at: { N: String(Math.floor(invitation.expiresAt.getTime() / 1000)) },
		});
	}

	async listOrganizationsForUser(userId: string): Promise<Organization[]> {
		const rows = await this.queryPrefix(userPartition(userId), "org#");
		const organizations: Organization[] = [];
		for (const row of rows) {
			const organization = await this.getOrganization(row.tenant_id?.S ?? "");
			if (organization !== null) {
				organizations.push(organization);
			}
		}
		return organizations.sort((left, right) => compareStrings(left.tenantId, right.tenantId));
	}

	async listOrganizationsByStatus(status: OrganizationStatus): Promise<Organization[]> {
		const organizations: Organization[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new ScanCommand({
					TableName: this.tableName,
					FilterExpression: "sk = :meta AND attribute_exists(owner_user_id) AND #status = :status",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: { ":meta": { S: "meta" }, ":status": { S: status } },
					ConsistentRead: true,
					Limit: this.queryPageLimit,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			for (const item of response.Items ?? []) {
				organizations.push(this.organizationFromItem(item));
			}
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return organizations.sort((left, right) => compareStrings(left.tenantId, right.tenantId));
	}

	async incrementOrganizationCreationAttempts(
		userId: string,
		now: Date,
		windowMilliseconds: number,
	): Promise<number> {
		const windowSeconds = Math.max(Math.floor(windowMilliseconds / 1000), 1);
		const bucket = Math.floor(Math.floor(now.getTime() / 1000) / windowSeconds);
		const expiresAt = Math.floor(now.getTime() / 1000) + windowSeconds + ONE_HOUR_SECONDS;
		const response = await this.client.send(
			new UpdateItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: userPartition(userId) }, sk: { S: `org_create_rate#${bucket}` } },
				UpdateExpression: "SET attempt_count = if_not_exists(attempt_count, :zero) + :one, expires_at = :expires",
				ExpressionAttributeValues: {
					":zero": { N: "0" },
					":one": { N: "1" },
					":expires": { N: String(expiresAt) },
				},
				ReturnValues: "ALL_NEW",
			}),
		);
		return Number(response.Attributes?.attempt_count?.N);
	}

	async listPendingInvitationsForEmail(email: string): Promise<Invitation[]> {
		const rows = await this.queryPrefix(`invitation_email#${email}`, "pending#");
		const invitations: Invitation[] = [];
		for (const row of rows) {
			const invitation = await this.getInvitation(row.invitation_id?.S ?? "");
			if (invitation !== null && invitation.status === "pending") {
				invitations.push(invitation);
			}
		}
		return invitations.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
	}

	async putBot(bot: Bot, reserveName: boolean): Promise<void> {
		const botItem = botCodec.encode(bot);
		if (!reserveName) {
			await this.put(botItem);
			return;
		}
		const nameItem: Item = {
			pk: { S: rosterPartition(bot.tenantId) },
			sk: { S: `bot_name#${bot.name}` },
			tenant_id: { S: bot.tenantId },
			bot_id: { S: bot.botId },
			name: { S: bot.name },
		};
		try {
			await this.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						{ Put: { TableName: this.tableName, Item: botItem } },
						{
							Put: {
								TableName: this.tableName,
								Item: nameItem,
								ConditionExpression: "attribute_not_exists(pk)",
							},
						},
					],
				}),
			);
		} catch (error) {
			if (
				error instanceof TransactionCanceledException &&
				(error.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")
			) {
				throw new DuplicateBotNameError(`Bot named '${bot.name}' already exists for tenant '${bot.tenantId}'.`);
			}
			throw error;
		}
	}

	async getBot(tenantId: string, botId: string): Promise<Bot | null> {
		const item = await this.get(rosterPartition(tenantId), `bot#${botId}`);
		return item === null ? null : botCodec.decode(item);
	}

	async getBotByName(tenantId: string, name: string): Promise<Bot | null> {
		const reservation = await this.get(rosterPartition(tenantId), `bot_name#${name}`);
		if (reservation !== null) {
			return this.getBot(tenantId, reservation.bot_id?.S ?? "");
		}
		for (const item of await this.queryPrefix(rosterPartition(tenantId), "bot#")) {
			if (item.name?.S === name) {
				return botCodec.decode(item);
			}
		}
		return null;
	}

	async listBots(tenantId: string): Promise<Bot[]> {
		const items = await this.queryPrefix(rosterPartition(tenantId), "bot#");
		return items.map(botCodec.decode).sort((left, right) => compareStrings(left.name, right.name));
	}

	async getBotIdempotency(tenantId: string, idempotencyKey: string): Promise<Bot | null> {
		const item = await this.get(rosterPartition(tenantId), `botidem#${idempotencyKey}`);
		const botId = item?.bot_id?.S;
		return botId === undefined || botId === "" ? null : this.getBot(tenantId, botId);
	}

	async putBotIdempotency(tenantId: string, idempotencyKey: string, bot: Bot): Promise<void> {
		await this.put({
			pk: { S: rosterPartition(tenantId) },
			sk: { S: `botidem#${idempotencyKey}` },
			tenant_id: { S: tenantId },
			bot_id: { S: bot.botId },
		});
	}

	async putChannel(channel: Channel): Promise<void> {
		await this.put(channelCodec.encodeChannel(channel));
		await this.putChannelIndexes(channel);
	}

	async putChannelIfAbsent(channel: Channel): Promise<Channel> {
		try {
			await this.client.send(
				new PutItemCommand({
					TableName: this.tableName,
					Item: channelCodec.encodeChannel(channel),
					ConditionExpression: "attribute_not_exists(pk)",
				}),
			);
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) {
				throw error;
			}
			const existing = await this.getChannel(channel.tenantId, channel.channelId);
			if (existing === null) {
				throw error;
			}
			await this.putChannelIndexes(existing);
			return existing;
		}
		await this.putChannelIndexes(channel);
		return channel;
	}

	async getChannel(tenantId: string, channelId: string): Promise<Channel | null> {
		const item = await this.get(channelPartition(tenantId, channelId), "meta");
		return item === null ? null : channelCodec.decodeChannel(item);
	}

	async listChannels(tenantId: string, userId: string): Promise<Channel[]> {
		const rows = await this.queryPrefix(rosterPartition(tenantId), `channel#${userId}#`);
		const channels: Channel[] = [];
		for (const row of rows) {
			const channel = await this.getChannel(tenantId, row.channel_id?.S ?? "");
			if (channel !== null) {
				channels.push(channel);
			}
		}
		return channels.sort((left, right) => compareStrings(left.channelId, right.channelId));
	}

	async resolveChannelTenant(channelId: string): Promise<string | null> {
		const item = await this.get(`channel_lookup#${channelId}`, "meta");
		return item?.tenant_id?.S ?? null;
	}

	async getChannelIdempotency(tenantId: string, idempotencyKey: string): Promise<Channel | null> {
		const item = await this.get(rosterPartition(tenantId), `chidem#${idempotencyKey}`);
		const channelId = item?.channel_id?.S;
		return channelId === undefined || channelId === "" ? null : this.getChannel(tenantId, channelId);
	}

	async putChannelIdempotency(tenantId: string, idempotencyKey: string, channel: Channel): Promise<void> {
		await this.put({
			pk: { S: rosterPartition(tenantId) },
			sk: { S: `chidem#${idempotencyKey}` },
			tenant_id: { S: tenantId },
			channel_id: { S: channel.channelId },
		});
	}

	async getPostIdempotency(
		tenantId: string,
		idempotencyKey: string,
	): Promise<{ message: ChannelMessageRecord; turnId: string | null } | null> {
		const key = postIdempotencyKey(tenantId, idempotencyKey);
		const item = await this.get(key.pk, key.sk);
		if (item === null) {
			return null;
		}
		const decoded = idempotencyCodec.decode(item);
		return {
			message: {
				messageId: decoded.messageId,
				channelId: decoded.channelId,
				tenantId: decoded.tenantId,
				seq: decoded.seq,
				authorKind: decoded.authorKind as ActorKind,
				authorId: decoded.authorId,
				body: decoded.body,
				addressedToBotId: decoded.addressedToBotId ?? null,
				createdAt: new Date(decoded.createdAt),
			},
			turnId: decoded.turnId ?? null,
		};
	}

	async putPostIdempotency(
		tenantId: string,
		idempotencyKey: string,
		message: ChannelMessageRecord,
		turnId: string | null,
	): Promise<void> {
		const key = postIdempotencyKey(tenantId, idempotencyKey);
		await this.put(
			idempotencyCodec.encode({
				pk: key.pk,
				sk: key.sk,
				tenantId,
				channelId: message.channelId,
				messageId: message.messageId,
				seq: message.seq,
				authorKind: message.authorKind,
				authorId: message.authorId,
				body: message.body,
				addressedToBotId: message.addressedToBotId ?? undefined,
				createdAt: message.createdAt.toISOString(),
				turnId: turnId ?? undefined,
			}),
		);
	}

	async putMessage(message: ChannelMessageRecord): Promise<void> {
		await this.put(channelCodec.encodeMessage(message));
	}

	async listMessages(tenantId: string, channelId: string, afterSeq: number): Promise<ChannelMessageRecord[]> {
		const messages: ChannelMessageRecord[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND sk > :sk",
					ExpressionAttributeValues: {
						":pk": { S: channelPartition(tenantId, channelId) },
						":sk": { S: channelCodec.messageSortKey(afterSeq) },
					},
					ConsistentRead: true,
					Limit: this.queryPageLimit,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			for (const item of response.Items ?? []) {
				if (item.sk?.S?.startsWith("msg#")) {
					messages.push(channelCodec.decodeMessage(item));
				}
			}
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return messages.sort((left, right) => left.seq - right.seq);
	}

	async putWorker(worker: Worker): Promise<void> {
		await this.put(workerCodec.encode({ ...worker, capabilities: [...worker.capabilities] }));
	}

	async getWorker(tenantId: string, workerId: string): Promise<Worker | null> {
		const item = await this.get(rosterPartition(tenantId), `worker#${workerId}`);
		return item === null ? null : workerCodec.decode(item);
	}

	async listWorkers(tenantId: string): Promise<Worker[]> {
		const items = await this.queryPrefix(rosterPartition(tenantId), "worker#");
		return items.map(workerCodec.decode).sort((left, right) => compareStrings(left.workerId, right.workerId));
	}

	async putTask(task: Task): Promise<void> {
		await this.put(taskCodec.encode(task));
		await this.put({
			pk: { S: rosterPartition(task.tenantId) },
			sk: { S: `task#${task.userId}#${task.taskId}` },
			tenant_id: { S: task.tenantId },
			user_id: { S: task.userId },
			task_id: { S: task.taskId },
		});
	}

	async getTask(tenantId: string, taskId: string): Promise<Task | null> {
		const item = await this.get(`${tenantId}#task#${taskId}`, "meta");
		return item === null ? null : taskCodec.decode(item);
	}

	async listTasks(tenantId: string, userId: string): Promise<Task[]> {
		const rows = await this.queryPrefix(rosterPartition(tenantId), `task#${userId}#`);
		const tasks: Task[] = [];
		for (const row of rows) {
			const task = await this.getTask(tenantId, row.task_id?.S ?? "");
			if (task !== null) {
				tasks.push(task);
			}
		}
		return tasks.sort((left, right) => compareStrings(left.taskId, right.taskId));
	}

	async getComputer(tenantId: string): Promise<Computer | null> {
		const item = await this.get(rosterPartition(tenantId), "computer");
		return item === null ? null : computerCodec.decode(item);
	}

	async putComputer(computer: Computer): Promise<void> {
		await this.put({
			...computerCodec.encode(computer),
			pk: { S: rosterPartition(computer.tenantId) },
			sk: { S: "computer" },
		});
	}

	async claimHostStartGeneration(tenantId: string, expectedGeneration: number, leaseExpiresAt: Date): Promise<Computer | null> {
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: rosterPartition(tenantId) }, sk: { S: "computer" } },
					UpdateExpression: "SET host_start_generation = :next, host_start_lease_expires_at = :lease",
					ConditionExpression: "attribute_exists(pk) AND host_start_generation = :expected",
					ExpressionAttributeValues: {
						":expected": { N: String(expectedGeneration) },
						":next": { N: String(expectedGeneration + 1) },
						":lease": { N: String(Math.floor(leaseExpiresAt.getTime() / 1000)) },
					},
					ReturnValues: "ALL_NEW",
				}),
			);
			return computerCodec.decode(response.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return null;
			}
			throw error;
		}
	}

	async markHostStartDispatched(tenantId: string, generation: number): Promise<boolean> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: rosterPartition(tenantId) }, sk: { S: "computer" } },
					UpdateExpression: "SET host_start_dispatched_generation = :generation",
					ConditionExpression:
						"attribute_exists(pk) AND host_start_generation = :generation AND host_start_dispatched_generation < :generation",
					ExpressionAttributeValues: { ":generation": { N: String(generation) } },
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return false;
			}
			throw error;
		}
	}

	async releaseHostStartDispatch(tenantId: string, generation: number): Promise<void> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: rosterPartition(tenantId) }, sk: { S: "computer" } },
					UpdateExpression: "SET host_start_dispatched_generation = :previous",
					ConditionExpression: "attribute_exists(pk) AND host_start_dispatched_generation = :generation",
					ExpressionAttributeValues: { ":generation": { N: String(generation) }, ":previous": { N: String(generation - 1) } },
				}),
			);
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) {
				throw error;
			}
		}
	}

	private async putChannelIndexes(channel: Channel): Promise<void> {
		await this.put({
			pk: { S: `channel_lookup#${channel.channelId}` },
			sk: { S: "meta" },
			tenant_id: { S: channel.tenantId },
			channel_id: { S: channel.channelId },
		});
		for (const participant of channel.participants) {
			if (participant.kind !== "human") {
				continue;
			}
			await this.put({
				pk: { S: rosterPartition(channel.tenantId) },
				sk: { S: `channel#${participant.actorId}#${channel.channelId}` },
				tenant_id: { S: channel.tenantId },
				user_id: { S: participant.actorId },
				channel_id: { S: channel.channelId },
			});
		}
	}

	private organizationFromItem(item: Item): Organization {
		const decoded = organizationCodec.decode(item);
		return {
			tenantId: decoded.tenantId,
			name: decoded.name,
			status: decoded.status as Organization["status"],
			ownerUserId: decoded.ownerUserId,
			createdAt: decoded.createdAt,
			awsAccountId: decoded.awsAccountId ?? null,
			awsCrossAccountRole: decoded.awsCrossAccountRole ?? null,
			awsExternalId: decoded.awsExternalId ?? null,
			awsSetupPath: (decoded.awsSetupPath ?? null) as Organization["awsSetupPath"],
			setupFeeCents: decoded.setupFeeCents ?? null,
			assistedSetupSession: decoded.assistedSetupSession ?? false,
			monthlyAwsSpendCeilingUsd:
				decoded.monthlyAwsSpendCeilingUsd === undefined ? null : Decimal.parse(decoded.monthlyAwsSpendCeilingUsd),
		};
	}

	private membershipFromItem(item: Item): Membership {
		const decoded = membershipCodec.decode(item);
		return { ...decoded, role: decoded.role as Membership["role"] };
	}

	private invitationFromItem(item: Item): Invitation {
		const decoded = invitationCodec.decode(item);
		return {
			...decoded,
			role: decoded.role as Invitation["role"],
			status: decoded.status as Invitation["status"],
		};
	}

	private async put(item: Item): Promise<void> {
		await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: item }));
	}

	private async get(partitionKey: string, sortKey: string): Promise<Item | null> {
		const response = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: partitionKey }, sk: { S: sortKey } },
				ConsistentRead: true,
			}),
		);
		return response.Item ?? null;
	}

	private async queryPrefix(partitionKey: string, sortKeyPrefix: string): Promise<Item[]> {
		const items: Item[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					ExpressionAttributeValues: { ":pk": { S: partitionKey }, ":prefix": { S: sortKeyPrefix } },
					ConsistentRead: true,
					Limit: this.queryPageLimit,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(...(response.Items ?? []));
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return items;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
