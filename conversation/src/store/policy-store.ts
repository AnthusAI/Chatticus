/**
 * Durable policy state: approvals, auto-review rules, authorized connections, member standing, and refusals.
 * Replaces the in-memory dicts and lists python/src/chatticus/control_plane.py kept for these records.
 */

import {
	ConditionalCheckFailedException,
	DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { MemberAuthorityCeiling } from "../policy/authorization-ceiling.ts";
import type { AutoReviewRule } from "../policy/models.ts";
import { approvalKey, connectionKey, memberCeilingKey, tenantConnectionEgressKey } from "./keys.ts";
import * as approvalCodec from "./codecs/approval.ts";
import * as connectionCodec from "./codecs/connection.ts";
import * as ruleCodec from "./codecs/rule.ts";
import * as standingCodec from "./codecs/standing.ts";

/** Raised when a create finds the item already present. */
export class PolicyItemAlreadyExistsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyItemAlreadyExistsError";
	}
}

/** Raised when a replace finds no item to replace. */
export class PolicyItemNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyItemNotFoundError";
	}
}

/** Storage the policy kernel reads and writes. Creates are conditional; replaces require the item to exist. */
export interface PolicyStore {
	createApproval(approval: approvalCodec.ApprovalItem): Promise<void>;
	getApproval(tenantId: string, approvalId: string): Promise<approvalCodec.ApprovalItem | null>;
	createRule(rule: AutoReviewRule): Promise<void>;
	listRules(tenantId: string): Promise<AutoReviewRule[]>;
	createConnectionRecord(record: connectionCodec.ConnectionRecord): Promise<void>;
	replaceConnectionRecord(record: connectionCodec.ConnectionRecord): Promise<void>;
	getConnectionRecord(grantingTenantId: string, proposalId: string): Promise<connectionCodec.ConnectionRecord | null>;
	listConnectionRecords(grantingTenantId: string): Promise<connectionCodec.ConnectionRecord[]>;
	putMemberCeiling(
		tenantId: string,
		memberUserId: string,
		actionType: string,
		ceiling: MemberAuthorityCeiling,
	): Promise<void>;
	getMemberCeiling(
		tenantId: string,
		memberUserId: string,
		actionType: string,
	): Promise<MemberAuthorityCeiling | null>;
	putTenantConnectionEgress(tenantId: string, ceiling: MemberAuthorityCeiling): Promise<void>;
	getTenantConnectionEgress(tenantId: string): Promise<MemberAuthorityCeiling | null>;
	createRefusal(refusal: ruleCodec.Refusal): Promise<void>;
	listRefusals(tenantId: string, kind: ruleCodec.RefusalKind): Promise<ruleCodec.Refusal[]>;
}

type Item = Record<string, AttributeValue>;

/** PolicyStore backed by the Messaging DynamoDB table. */
export class DynamoPolicyStore implements PolicyStore {
	private readonly client: DynamoDBClient;
	private readonly tableName: string;

	constructor(client: DynamoDBClient, tableName: string) {
		this.client = client;
		this.tableName = tableName;
	}

	async createApproval(approval: approvalCodec.ApprovalItem): Promise<void> {
		await this.create(approvalCodec.encode(approval), `approval ${JSON.stringify(approval.approvalId)}`);
	}

	async getApproval(tenantId: string, approvalId: string): Promise<approvalCodec.ApprovalItem | null> {
		const item = await this.get(approvalKey(tenantId, approvalId));
		return item === null ? null : approvalCodec.decode(item);
	}

	async createRule(rule: AutoReviewRule): Promise<void> {
		await this.create(ruleCodec.encode(rule), `rule ${JSON.stringify(rule.ruleId)}`);
	}

	async listRules(tenantId: string): Promise<AutoReviewRule[]> {
		const items = await this.list(`${tenantId}#rules`, "RULE#");
		return items.map(ruleCodec.decode);
	}

	async createConnectionRecord(record: connectionCodec.ConnectionRecord): Promise<void> {
		await this.create(connectionCodec.encode(record), `connection ${JSON.stringify(record.proposal.proposalId)}`);
	}

	async replaceConnectionRecord(record: connectionCodec.ConnectionRecord): Promise<void> {
		await this.replace(connectionCodec.encode(record), `connection ${JSON.stringify(record.proposal.proposalId)}`);
	}

	async getConnectionRecord(
		grantingTenantId: string,
		proposalId: string,
	): Promise<connectionCodec.ConnectionRecord | null> {
		const item = await this.get(connectionKey(grantingTenantId, proposalId));
		return item === null ? null : connectionCodec.decode(item);
	}

	async listConnectionRecords(grantingTenantId: string): Promise<connectionCodec.ConnectionRecord[]> {
		const items = await this.list(`${grantingTenantId}#connections`, "CONN#");
		return items.map(connectionCodec.decode);
	}

	async putMemberCeiling(
		tenantId: string,
		memberUserId: string,
		actionType: string,
		ceiling: MemberAuthorityCeiling,
	): Promise<void> {
		await this.put(standingCodec.encodeMemberCeiling(tenantId, memberUserId, actionType, ceiling));
	}

	async getMemberCeiling(
		tenantId: string,
		memberUserId: string,
		actionType: string,
	): Promise<MemberAuthorityCeiling | null> {
		const item = await this.get(memberCeilingKey(tenantId, memberUserId, actionType));
		return item === null ? null : standingCodec.decodeCeiling(item);
	}

	async putTenantConnectionEgress(tenantId: string, ceiling: MemberAuthorityCeiling): Promise<void> {
		await this.put(standingCodec.encodeTenantConnectionEgress(tenantId, ceiling));
	}

	async getTenantConnectionEgress(tenantId: string): Promise<MemberAuthorityCeiling | null> {
		const item = await this.get(tenantConnectionEgressKey(tenantId));
		return item === null ? null : standingCodec.decodeCeiling(item);
	}

	async createRefusal(refusal: ruleCodec.Refusal): Promise<void> {
		await this.create(ruleCodec.encodeRefusal(refusal), `refusal ${JSON.stringify(refusal.refusalId)}`);
	}

	async listRefusals(tenantId: string, kind: ruleCodec.RefusalKind): Promise<ruleCodec.Refusal[]> {
		const items = await this.list(`${tenantId}#rules`, "REFUSAL#");
		return items.map(ruleCodec.decodeRefusal).filter((refusal) => refusal.kind === kind);
	}

	private async create(item: Item, description: string): Promise<void> {
		try {
			await this.client.send(
				new PutItemCommand({
					TableName: this.tableName,
					Item: item,
					ConditionExpression: "attribute_not_exists(pk)",
				}),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new PolicyItemAlreadyExistsError(`The ${description} already exists.`);
			}
			throw error;
		}
	}

	private async replace(item: Item, description: string): Promise<void> {
		try {
			await this.client.send(
				new PutItemCommand({
					TableName: this.tableName,
					Item: item,
					ConditionExpression: "attribute_exists(pk)",
				}),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new PolicyItemNotFoundError(`The ${description} does not exist.`);
			}
			throw error;
		}
	}

	private async put(item: Item): Promise<void> {
		await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: item }));
	}

	private async get(key: { pk: string; sk: string }): Promise<Item | null> {
		const response = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: key.pk }, sk: { S: key.sk } },
				ConsistentRead: true,
			}),
		);
		return response.Item ?? null;
	}

	private async list(partitionKey: string, sortKeyPrefix: string): Promise<Item[]> {
		const items: Item[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					ExpressionAttributeValues: { ":pk": { S: partitionKey }, ":prefix": { S: sortKeyPrefix } },
					ConsistentRead: true,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(...(response.Items ?? []));
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return items;
	}
}
