import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AuthorizedRequest } from "./iam-policy-evaluator.ts";

/** A DynamoDB or S3 request an owner made, with what a scenario needs to judge and to report it. */
export type RecordedAwsRequest = AuthorizedRequest & {
	readonly service: "dynamodb" | "s3";
	/** The table or bucket name. */
	readonly store: string;
	/** The partition keys of a table request, or the object key or list prefix of a bucket request. */
	readonly keys: readonly string[];
};

const LEADING_KEYS = "dynamodb:LeadingKeys";
const S3_PREFIX = "s3:prefix";

/** The account and Region the recorder puts in table ARNs; scenarios build the policy under the same ones. */
export const RECORDED_TABLE_ARN_PREFIX = "arn:aws:dynamodb:us-east-1:111122223333:table/";

/** The ARN of a table in the recorder's account. */
export const tableArnOf = (tableName: string): string => `${RECORDED_TABLE_ARN_PREFIX}${tableName}`;

type KeyMap = Record<string, AttributeValue>;

type DynamoInput = {
	TableName?: string;
	IndexName?: string;
	Key?: KeyMap;
	Item?: KeyMap;
	KeyConditionExpression?: string;
	ExpressionAttributeValues?: KeyMap;
	RequestItems?: Record<string, { Keys?: KeyMap[] }>;
	TransactItems?: Array<{
		Put?: { TableName: string; Item: KeyMap };
		Update?: { TableName: string; Key: KeyMap };
		Delete?: { TableName: string; Key: KeyMap };
		ConditionCheck?: { TableName: string; Key: KeyMap };
	}>;
};

const partitionKeyOf = (attributes: KeyMap | undefined): string[] => {
	const value = attributes?.["pk"]?.S;
	return value === undefined ? [] : [value];
};

function dynamoRequest(action: string, tableName: string, keys: readonly string[], indexName?: string): RecordedAwsRequest {
	return {
		service: "dynamodb",
		action: `dynamodb:${action}`,
		store: tableName,
		keys,
		resourceArn: indexName === undefined ? tableArnOf(tableName) : `${tableArnOf(tableName)}/index/${indexName}`,
		contextKeys: keys.length === 0 ? {} : { [LEADING_KEYS]: keys },
	};
}

function queryKeys(input: DynamoInput): string[] {
	const placeholder = /\bpk\s*=\s*(:\w+)/.exec(input.KeyConditionExpression ?? "")?.[1];
	const value = placeholder === undefined ? undefined : input.ExpressionAttributeValues?.[placeholder]?.S;
	return value === undefined ? [] : [value];
}

function dynamoRequestsOf(commandName: string, input: DynamoInput): RecordedAwsRequest[] {
	const table = input.TableName ?? "";
	switch (commandName) {
		case "GetItemCommand":
			return [dynamoRequest("GetItem", table, partitionKeyOf(input.Key))];
		case "PutItemCommand":
			return [dynamoRequest("PutItem", table, partitionKeyOf(input.Item))];
		case "UpdateItemCommand":
			return [dynamoRequest("UpdateItem", table, partitionKeyOf(input.Key))];
		case "DeleteItemCommand":
			return [dynamoRequest("DeleteItem", table, partitionKeyOf(input.Key))];
		case "QueryCommand":
			return [dynamoRequest("Query", table, queryKeys(input), input.IndexName)];
		case "BatchGetItemCommand":
			return Object.entries(input.RequestItems ?? {}).map(([name, request]) =>
				dynamoRequest("BatchGetItem", name, (request.Keys ?? []).flatMap((key) => partitionKeyOf(key))),
			);
		case "TransactWriteItemsCommand":
			return (input.TransactItems ?? []).flatMap((item) => {
				if (item.Put !== undefined) return [dynamoRequest("PutItem", item.Put.TableName, partitionKeyOf(item.Put.Item))];
				if (item.Update !== undefined) return [dynamoRequest("UpdateItem", item.Update.TableName, partitionKeyOf(item.Update.Key))];
				if (item.Delete !== undefined) return [dynamoRequest("DeleteItem", item.Delete.TableName, partitionKeyOf(item.Delete.Key))];
				if (item.ConditionCheck !== undefined) {
					return [dynamoRequest("ConditionCheckItem", item.ConditionCheck.TableName, partitionKeyOf(item.ConditionCheck.Key))];
				}
				return [dynamoRequest("UnknownTransactionItem", table, [])];
			});
		default:
			return [dynamoRequest(commandName.replace(/Command$/, ""), table, [])];
	}
}

function s3Request(action: string, bucket: string, key: string, listing: boolean): RecordedAwsRequest {
	return {
		service: "s3",
		action: `s3:${action}`,
		store: bucket,
		keys: [key],
		resourceArn: listing ? `arn:aws:s3:::${bucket}` : `arn:aws:s3:::${bucket}/${key}`,
		contextKeys: listing ? { [S3_PREFIX]: [key] } : {},
	};
}

type S3Input = { Bucket?: string; Key?: string; Prefix?: string; Delete?: { Objects?: Array<{ Key?: string }> } };

function s3RequestsOf(commandName: string, input: S3Input): RecordedAwsRequest[] {
	const bucket = input.Bucket ?? "";
	switch (commandName) {
		case "GetObjectCommand":
		case "HeadObjectCommand":
			return [s3Request("GetObject", bucket, input.Key ?? "", false)];
		case "PutObjectCommand":
			return [s3Request("PutObject", bucket, input.Key ?? "", false)];
		case "DeleteObjectCommand":
			return [s3Request("DeleteObject", bucket, input.Key ?? "", false)];
		case "DeleteObjectsCommand":
			return (input.Delete?.Objects ?? []).map((object) => s3Request("DeleteObject", bucket, object.Key ?? "", false));
		case "ListObjectsV2Command":
			return [s3Request("ListBucket", bucket, input.Prefix ?? "", true)];
		default:
			return [s3Request(commandName.replace(/Command$/, ""), bucket, input.Key ?? "", false)];
	}
}

function recordingProxy<Client extends object>(client: Client, record: (commandName: string, input: unknown) => void): Client {
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property !== "send") return Reflect.get(target, property, receiver);
			return (command: { constructor: { name: string }; input: unknown }, ...rest: unknown[]) => {
				record(command.constructor.name, command.input);
				return (target as unknown as { send: (...args: unknown[]) => unknown }).send(command, ...rest);
			};
		},
	});
}

/** A DynamoDB client that notes every request it sends in `sink` before passing it on unchanged. */
export function recordingDynamoClient(client: DynamoDBClient, sink: RecordedAwsRequest[]): DynamoDBClient {
	return recordingProxy(client, (name, input) => sink.push(...dynamoRequestsOf(name, input as DynamoInput)));
}

/** An S3 client that notes every request it sends in `sink` before passing it on unchanged. */
export function recordingS3Client(client: S3Client, sink: RecordedAwsRequest[]): S3Client {
	return recordingProxy(client, (name, input) => sink.push(...s3RequestsOf(name, input as S3Input)));
}
