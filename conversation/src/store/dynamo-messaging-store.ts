/**
 * Production MessagingStore over the Messaging DynamoDB table.
 * Ported from python/src/chatticus/messaging/store.py DynamoMessagingStore (lines 1123-2377, 2723-2812).
 */

import {
	ConditionalCheckFailedException,
	DeleteItemCommand,
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
import * as fileAuditCodec from "./codecs/file-audit.ts";
import type { FileAuditRecord } from "./codecs/file-audit.ts";
import * as idempotencyCodec from "./codecs/idempotency.ts";
import * as identityCodec from "./codecs/identity.ts";
import * as invitationCodec from "./codecs/invitation.ts";
import * as liveFileOperationCodec from "./codecs/live-file-operation.ts";
import { encodeOutcome } from "./codecs/live-file-operation.ts";
import type { LiveFileOperation, LiveFileOperationStatus } from "./codecs/live-file-operation.ts";
import * as membershipCodec from "./codecs/membership.ts";
import * as organizationCodec from "./codecs/organization.ts";
import * as taskCodec from "./codecs/task.ts";
import type { Task } from "./codecs/task.ts";
import { formatIsoDateTime } from "./codecs/util.ts";
import * as workerCodec from "./codecs/worker.ts";
import type { Worker } from "./codecs/worker.ts";
import { computerRecordKey, fileAuditKey, fileAuditPartition, liveFileOperationKey, liveFileOperationPartition, postIdempotencyKey } from "./keys.ts";
import type { FileAuditFinish, MessagingStore, OwnerBootstrapRecord, OwnerDispatchRecord } from "./messaging-store.ts";
import { retryTransient } from "./transient-retry.ts";

type Item = Record<string, AttributeValue>;

const ONE_HOUR_SECONDS = 3600;

function rosterPartition(tenantId: string): string {
	return `${tenantId}#roster`;
}

function computerRecordItemKey(tenantId: string): { pk: AttributeValue; sk: AttributeValue } {
	const key = computerRecordKey(tenantId);
	return { pk: { S: key.pk }, sk: { S: key.sk } };
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
		return this.incrementRateCounter(userId, "org_create_rate", now, Math.max(Math.floor(windowMilliseconds / 1000), 1));
	}

	async incrementRateCounter(userId: string, name: string, now: Date, windowSeconds: number): Promise<number> {
		const bucket = Math.floor(Math.floor(now.getTime() / 1000) / windowSeconds);
		const expiresAt = Math.floor(now.getTime() / 1000) + windowSeconds + ONE_HOUR_SECONDS;
		const response = await this.client.send(
			new UpdateItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: userPartition(userId) }, sk: { S: `${name}#${bucket}` } },
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
			await retryTransient(() => this.client.send(
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
			));
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
		const key = computerRecordKey(tenantId);
		const item = await this.get(key.pk, key.sk);
		return item === null ? null : computerCodec.decode(item);
	}

	async putComputer(computer: Computer): Promise<void> {
		const key = computerRecordItemKey(computer.tenantId);
		await this.put({ ...computerCodec.encode(computer), pk: key.pk, sk: key.sk });
	}

	async claimHostStartGeneration(tenantId: string, expectedGeneration: number, leaseExpiresAt: Date): Promise<Computer | null> {
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
					UpdateExpression: "SET host_start_generation = :next, host_start_lease_expires_at = :lease REMOVE live_writer_host_id, " + computerCodec.OWNER_ATTRIBUTE_NAMES.join(", "),
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

	async settleLostComputerHost(tenantId: string, expectedGeneration: number, lostAt: Date, hydrateRequired: boolean): Promise<Computer | null> {
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
					UpdateExpression:
						"SET stopped = :stopped, model_ready = :off, workspace_ready = :off, browser_ready = :off, disk_dirty = :off, hydrate_required = :hydrate, host_lost_at = :lostAt, host_lost_generation = :generation REMOVE live_writer_host_id, " + computerCodec.OWNER_ATTRIBUTE_NAMES.join(", "),
					ConditionExpression:
						"attribute_exists(pk) AND host_start_generation = :generation AND (disk_dirty = :on OR attribute_exists(live_writer_host_id))",
					ExpressionAttributeValues: {
						":stopped": { BOOL: true },
						":off": { BOOL: false },
						":on": { BOOL: true },
						":hydrate": { BOOL: hydrateRequired },
						":lostAt": { N: String(Math.floor(lostAt.getTime() / 1000)) },
						":generation": { N: String(expectedGeneration) },
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

	async recordComputerSnapshotPublished(tenantId: string, published: { snapshotUri: string; snapshotChecksum: string }): Promise<Computer | null> {
		return this.updateComputerWhere(tenantId, {
			update: "SET snapshot_uri = :uri, snapshot_checksum = :checksum, snapshot_generation = snapshot_generation + :one, disk_dirty = :clean",
			condition: "attribute_exists(pk) AND hydrate_required = :no",
			values: {
				":uri": { S: published.snapshotUri },
				":checksum": { S: published.snapshotChecksum },
				":one": { N: "1" },
				":clean": { BOOL: false },
				":no": { BOOL: false },
			},
		});
	}

	async recordComputerHydrated(tenantId: string): Promise<Computer | null> {
		return this.updateComputerWhere(tenantId, {
			update: "SET hydrate_required = :no, disk_dirty = :no REMOVE intended_host_worker_id",
			condition: "attribute_exists(pk)",
			values: { ":no": { BOOL: false } },
		});
	}

	async markComputerDiskDirty(tenantId: string): Promise<boolean> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
					UpdateExpression: "SET disk_dirty = :dirty",
					ConditionExpression: "attribute_exists(pk)",
					ExpressionAttributeValues: { ":dirty": { BOOL: true } },
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

	async claimComputerDiskWriter(tenantId: string, hostId: string): Promise<boolean> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
					UpdateExpression: "SET live_writer_host_id = :host",
					ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(live_writer_host_id) OR live_writer_host_id = :host)",
					ExpressionAttributeValues: { ":host": { S: hostId } },
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

	async releaseHostStartLease(tenantId: string, generation: number): Promise<boolean> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
					UpdateExpression: "REMOVE host_start_lease_expires_at",
					ConditionExpression: "attribute_exists(pk) AND host_start_generation = :generation",
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

	async markHostStartDispatched(tenantId: string, generation: number): Promise<boolean> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
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
					Key: computerRecordItemKey(tenantId),
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

	async consumeOwnerBootstrap(tenantId: string, bootstrap: OwnerBootstrapRecord): Promise<Computer | null> {
		const removed = computerCodec.OWNER_ATTRIBUTE_NAMES.filter((name) => !["owner_id", "owner_protocol_version", "owner_started_at", "owner_credentials_expire_at"].includes(name));
		return this.updateComputerWhere(tenantId, {
			update: `SET owner_id = :owner, owner_generation = :generation, owner_protocol_version = :version, owner_started_at = :startedAt, owner_credentials_expire_at = :credentialsExpireAt REMOVE ${removed.join(", ")}`,
			condition: "attribute_exists(pk) AND host_start_generation = :generation AND (attribute_not_exists(owner_generation) OR owner_generation < :generation)",
			values: {
				":owner": { S: bootstrap.ownerId },
				":generation": { N: String(bootstrap.generation) },
				":version": { N: String(bootstrap.protocolVersion) },
				":startedAt": { N: String(Math.floor(bootstrap.startedAt.getTime() / 1000)) },
				":credentialsExpireAt": { N: String(Math.floor(bootstrap.credentialsExpireAt.getTime() / 1000)) },
			},
		});
	}

	async recordOwnerPoll(tenantId: string, workerId: string, poll: { sequence: number; state: string; at: Date; paceMilliseconds: number }): Promise<boolean> {
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: rosterPartition(tenantId) }, sk: { S: `worker#${workerId}` } },
					UpdateExpression: "SET last_heartbeat_at = :at, poll_sequence = :sequence, poll_state = :state, poll_pace_ms = :pace",
					ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(poll_sequence) OR poll_sequence <= :sequence)",
					ExpressionAttributeValues: {
						":at": { S: formatIsoDateTime(poll.at) },
						":sequence": { N: String(poll.sequence) },
						":state": { S: poll.state },
						":pace": { N: String(poll.paceMilliseconds) },
					},
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return false;
			throw error;
		}
	}

	async updateOwnerPresence(tenantId: string, ownerId: string, change: { protocolVersion?: number; idleSinceAt?: Date | null }): Promise<boolean> {
		const sets: string[] = [];
		const removes: string[] = [];
		const values: Item = { ":owner": { S: ownerId } };
		if (change.protocolVersion !== undefined) {
			sets.push("owner_protocol_version = :version");
			values[":version"] = { N: String(change.protocolVersion) };
		}
		if (change.idleSinceAt instanceof Date) {
			sets.push("idle_since_at = :idleSince");
			values[":idleSince"] = { N: String(Math.floor(change.idleSinceAt.getTime() / 1000)) };
		} else if (change.idleSinceAt === null) {
			removes.push("idle_since_at");
		}
		if (sets.length === 0 && removes.length === 0) return true;
		const update = [sets.length === 0 ? "" : `SET ${sets.join(", ")}`, removes.length === 0 ? "" : `REMOVE ${removes.join(", ")}`].filter((part) => part !== "").join(" ");
		return (await this.updateComputerWhere(tenantId, { update, condition: "attribute_exists(pk) AND owner_id = :owner", values })) !== null;
	}

	async offerOwnerDispatch(tenantId: string, ownerId: string, expectedDispatchId: string | null, dispatch: OwnerDispatchRecord): Promise<boolean> {
		const dispatchCondition = expectedDispatchId === null ? "attribute_not_exists(dispatch_id)" : "dispatch_id = :expectedDispatch";
		const values: Item = {
			":owner": { S: ownerId },
			":dispatchId": { S: dispatch.dispatchId },
			":turnId": { S: dispatch.turnId },
			":actionId": { S: dispatch.actionId },
			":attempt": { N: String(dispatch.attempt) },
			":lease": { N: String(Math.floor(dispatch.leaseExpiresAt.getTime() / 1000)) },
		};
		if (expectedDispatchId !== null) values[":expectedDispatch"] = { S: expectedDispatchId };
		return (
			(await this.updateComputerWhere(tenantId, {
				update: "SET dispatch_id = :dispatchId, dispatch_turn_id = :turnId, dispatch_action_id = :actionId, dispatch_attempt = :attempt, dispatch_lease_expires_at = :lease",
				condition: `attribute_exists(pk) AND owner_id = :owner AND attribute_not_exists(owner_stop_approved_at) AND ${dispatchCondition}`,
				values,
			})) !== null
		);
	}

	async approveOwnerStop(
		tenantId: string,
		ownerId: string,
		expectedDispatchId: string | null,
		expectedFileOperationId: string | null,
		approvedAt: Date,
	): Promise<boolean> {
		const dispatchCondition = expectedDispatchId === null ? "attribute_not_exists(dispatch_id)" : "dispatch_id = :expectedDispatch";
		const fileCondition = expectedFileOperationId === null ? "attribute_not_exists(file_operation_id)" : "file_operation_id = :expectedFileOperation";
		const values: Item = { ":owner": { S: ownerId }, ":approvedAt": { N: String(Math.floor(approvedAt.getTime() / 1000)) } };
		if (expectedDispatchId !== null) values[":expectedDispatch"] = { S: expectedDispatchId };
		if (expectedFileOperationId !== null) values[":expectedFileOperation"] = { S: expectedFileOperationId };
		return (
			(await this.updateComputerWhere(tenantId, {
				update: "SET owner_stop_approved_at = :approvedAt",
				condition: `attribute_exists(pk) AND owner_id = :owner AND ${dispatchCondition} AND ${fileCondition}`,
				values,
			})) !== null
		);
	}

	async touchInteractiveWindow(tenantId: string, ownerId: string, generation: number, until: Date): Promise<boolean> {
		return (
			(await this.updateComputerWhere(tenantId, {
				update: "SET interactive_until_at = :until",
				condition: "attribute_exists(pk) AND owner_id = :owner AND owner_generation = :generation AND attribute_not_exists(owner_stop_approved_at)",
				values: { ":until": { N: String(Math.floor(until.getTime() / 1000)) }, ":owner": { S: ownerId }, ":generation": { N: String(generation) } },
			})) !== null
		);
	}

	async queueLiveFileOperation(operation: LiveFileOperation, interactiveUntilAt: Date): Promise<boolean> {
		const computerKey = computerRecordItemKey(operation.tenantId);
		try {
			await retryTransient(() =>
				this.client.send(
					new TransactWriteItemsCommand({
						TransactItems: [
							{
								Update: {
									TableName: this.tableName,
									Key: computerKey,
									UpdateExpression: "SET interactive_until_at = :until, file_operation_id = :operation",
									ConditionExpression:
										"attribute_exists(pk) AND owner_id = :owner AND owner_generation = :generation AND attribute_not_exists(owner_stop_approved_at)",
									ExpressionAttributeValues: {
										":until": { N: String(Math.floor(interactiveUntilAt.getTime() / 1000)) },
										":operation": { S: operation.operationId },
										":owner": { S: operation.ownerId },
										":generation": { N: String(operation.generation) },
									},
								},
							},
							{
								Put: {
									TableName: this.tableName,
									Item: liveFileOperationCodec.encode(operation),
									ConditionExpression: "attribute_not_exists(pk)",
								},
							},
						],
					}),
				),
			);
			return true;
		} catch (error) {
			if (
				error instanceof TransactionCanceledException &&
				(error.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")
			) {
				return false;
			}
			throw error;
		}
	}

	async getLiveFileOperation(tenantId: string, operationId: string, now: Date): Promise<LiveFileOperation | null> {
		const key = liveFileOperationKey(tenantId, operationId);
		const item = await this.get(key.pk, key.sk);
		if (item === null) return null;
		const operation = liveFileOperationCodec.decode(item);
		return liveFileOperationCodec.isExpired(operation, now) ? null : operation;
	}

	async listLiveFileOperations(tenantId: string, now: Date): Promise<LiveFileOperation[]> {
		const rows = await this.queryPrefix(liveFileOperationPartition(tenantId), "op#");
		return rows
			.map((row) => liveFileOperationCodec.decode(row))
			.filter((operation) => !liveFileOperationCodec.isExpired(operation, now))
			.sort((left, right) => left.queuedAt.getTime() - right.queuedAt.getTime() || compareStrings(left.operationId, right.operationId));
	}

	async countOpenLiveFileOperations(tenantId: string, now: Date): Promise<number> {
		let count = 0;
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					FilterExpression: "#status IN (:pending, :delivered) AND expires_at > :now",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":pk": { S: liveFileOperationPartition(tenantId) },
						":prefix": { S: "op#" },
						":pending": { S: "pending" },
						":delivered": { S: "delivered" },
						":now": { N: String(Math.floor(now.getTime() / 1000)) },
					},
					Select: "COUNT",
					ConsistentRead: true,
					Limit: this.queryPageLimit,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			count += response.Count ?? 0;
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return count;
	}

	async deliverLiveFileOperation(
		tenantId: string,
		operationId: string,
		delivery: { ownerId: string; generation: number; sequence: number; at: Date },
	): Promise<boolean> {
		const key = liveFileOperationKey(tenantId, operationId);
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: key.pk }, sk: { S: key.sk } },
					UpdateExpression: "SET #status = :delivered, delivered_at = :at, delivered_sequence = :sequence",
					ConditionExpression: "attribute_exists(pk) AND #status = :pending AND owner_id = :owner AND generation = :generation AND expires_at > :now",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":delivered": { S: "delivered" },
						":pending": { S: "pending" },
						":at": { S: delivery.at.toISOString() },
						":sequence": { N: String(delivery.sequence) },
						":owner": { S: delivery.ownerId },
						":generation": { N: String(delivery.generation) },
						":now": { N: String(Math.floor(delivery.at.getTime() / 1000)) },
					},
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return false;
			throw error;
		}
	}

	async abandonLiveFileOperation(tenantId: string, operationId: string, now: Date): Promise<LiveFileOperationStatus | "absent"> {
		const key = liveFileOperationKey(tenantId, operationId);
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: key.pk }, sk: { S: key.sk } },
					UpdateExpression: "SET #status = :abandoned REMOVE #request, outcome",
					ConditionExpression: "attribute_exists(pk) AND #status = :pending",
					ExpressionAttributeNames: { "#status": "status", "#request": "request" },
					ExpressionAttributeValues: { ":abandoned": { S: "abandoned" }, ":pending": { S: "pending" } },
				}),
			);
			return "abandoned";
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) throw error;
			return (await this.getLiveFileOperation(tenantId, operationId, now))?.status ?? "absent";
		}
	}

	async completeLiveFileOperation(tenantId: string, operationId: string, outcome: string, now: Date): Promise<LiveFileOperation | null> {
		const key = liveFileOperationKey(tenantId, operationId);
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: key.pk }, sk: { S: key.sk } },
					UpdateExpression: "SET #status = :done, outcome = :outcome",
					ConditionExpression: "attribute_exists(pk) AND #status = :delivered AND expires_at > :now",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":done": { S: "done" },
						":delivered": { S: "delivered" },
						":outcome": encodeOutcome(outcome),
						":now": { N: String(Math.floor(now.getTime() / 1000)) },
					},
					ReturnValues: "ALL_NEW",
				}),
			);
			return liveFileOperationCodec.decode(response.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return null;
			throw error;
		}
	}

	async markLiveFileOperationWaiterGone(tenantId: string, operationId: string): Promise<boolean> {
		const key = liveFileOperationKey(tenantId, operationId);
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: key.pk }, sk: { S: key.sk } },
					UpdateExpression: "SET waiter_gone = :gone",
					ConditionExpression: "attribute_exists(pk) AND #status = :delivered",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: { ":gone": { BOOL: true }, ":delivered": { S: "delivered" } },
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return false;
			throw error;
		}
	}

	async deleteLiveFileOperation(tenantId: string, operationId: string): Promise<void> {
		const key = liveFileOperationKey(tenantId, operationId);
		await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } } }));
	}

	async putFileAudit(record: FileAuditRecord): Promise<void> {
		await this.client.send(
			new PutItemCommand({ TableName: this.tableName, Item: fileAuditCodec.encode(record), ConditionExpression: "attribute_not_exists(pk)" }),
		);
	}

	async getFileAudit(tenantId: string, atMilliseconds: number, operationId: string, now: Date): Promise<FileAuditRecord | null> {
		const key = fileAuditKey(tenantId, atMilliseconds, operationId);
		const item = await this.get(key.pk, key.sk);
		if (item === null) return null;
		const record = fileAuditCodec.decode(item);
		return record.expiresAt.getTime() <= now.getTime() ? null : record;
	}

	async finalizeFileAudit(tenantId: string, atMilliseconds: number, operationId: string, finish: FileAuditFinish): Promise<boolean> {
		const key = fileAuditKey(tenantId, atMilliseconds, operationId);
		const sets = ["outcome = :outcome", "finished_at = :finishedAt"];
		const values: Item = { ":outcome": { S: finish.outcome }, ":finishedAt": { S: finish.finishedAt.toISOString() } };
		const texts: [string, string, string | undefined][] = [
			["error_code", ":errorCode", finish.errorCode],
			["resolved_path", ":resolvedPath", finish.resolvedPath],
			["kept_as", ":keptAs", finish.keptAs],
			["sha256_before_reported", ":beforeReported", finish.sha256BeforeReported],
			["sha256_after_reported", ":afterReported", finish.sha256AfterReported],
		];
		for (const [attribute, placeholder, value] of texts) {
			if (value === undefined) continue;
			sets.push(`${attribute} = ${placeholder}`);
			values[placeholder] = { S: value };
		}
		if (finish.removed !== undefined) {
			sets.push("removed = :removed");
			values[":removed"] = { N: String(finish.removed) };
		}
		if (finish.flags !== undefined && finish.flags.length > 0) {
			sets.push("flags = :flags");
			values[":flags"] = { SS: [...finish.flags] };
		}
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: key.pk }, sk: { S: key.sk } },
					UpdateExpression: `SET ${sets.join(", ")}`,
					ConditionExpression: "attribute_exists(pk)",
					ExpressionAttributeValues: values,
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return false;
			throw error;
		}
	}

	async listFileAuditRecords(tenantId: string, now: Date): Promise<FileAuditRecord[]> {
		const rows = await this.queryPrefix(fileAuditPartition(tenantId), "at#");
		return rows
			.map((row) => fileAuditCodec.decode(row))
			.filter((record) => record.expiresAt.getTime() > now.getTime())
			.sort((left, right) => left.at.getTime() - right.at.getTime() || compareStrings(left.operationId, right.operationId));
	}

	private async updateComputerWhere(
		tenantId: string,
		change: { update: string; condition: string; values: Item },
	): Promise<Computer | null> {
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: computerRecordItemKey(tenantId),
					UpdateExpression: change.update,
					ConditionExpression: change.condition,
					ExpressionAttributeValues: change.values,
					ReturnValues: "ALL_NEW",
				}),
			);
			return computerCodec.decode(response.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return null;
			throw error;
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
