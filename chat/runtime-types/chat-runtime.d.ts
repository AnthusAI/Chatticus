import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";

export type SiteHostedChatResources = {
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly sessionBucket: string;
	readonly turnRunsQueueUrl: string;
	readonly turnProbesQueueUrl: string;
	readonly assistantBotId: string;
	readonly assistantBotName: string;
	readonly openAiApiKeyParameter?: string;
};

export type SiteHostedChatClients = {
	readonly dynamo: DynamoDBClient;
	readonly s3: S3Client;
	readonly sqs: SQSClient;
	readonly parameters: { send(command: any): Promise<any> };
};

export type SiteHostedChatEnvironment = Record<string, string | undefined>;
export type SiteHostedRunRecord = { readonly body: string; readonly receiptHandle: string };
export type SiteHostedProbeRecord = { readonly body: string };
export type SiteHostedPrincipal = {
	readonly kind: "user" | "operator" | "worker" | "integration";
	readonly tenantId: string;
	readonly userId: string | null;
	readonly workerId: string | null;
	readonly organizationStatus: "pending" | "enabled" | "suspended" | null;
	readonly role: "owner" | "member" | null;
};

export declare function siteHostedChatResourcesFromEnvironment(environment: SiteHostedChatEnvironment): SiteHostedChatResources;
export declare function siteHostedChatClients(): SiteHostedChatClients;
export declare function createSiteHostedChatDependencies(resources: SiteHostedChatResources, clients: SiteHostedChatClients, clock?: { now(): Date }): Record<string, unknown>;
export declare function createSiteHostedRunHandler(environment: SiteHostedChatEnvironment, clients?: SiteHostedChatClients): (event: { Records: readonly SiteHostedRunRecord[] }, context: { getRemainingTimeInMillis(): number }) => Promise<void>;
export declare function createSiteHostedProbeHandler(environment: SiteHostedChatEnvironment, clients?: SiteHostedChatClients): (event: { Records: readonly SiteHostedProbeRecord[] }) => Promise<void>;
export declare function createSiteHostedChatApp(environment: SiteHostedChatEnvironment, resolvePrincipal: (request: Request) => Promise<SiteHostedPrincipal | null>, clients?: SiteHostedChatClients): { fetch(request: Request): Promise<Response> };
