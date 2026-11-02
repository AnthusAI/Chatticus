import { describe, expect, it } from "vitest";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";
import { DynamoTurnAdmission } from "../src/store/turn-admission-store.ts";
import { DynamoTurnControlStore } from "../src/store/turn-store.ts";
import { SqsTurnProbeQueue, SqsTurnRunQueue } from "../src/turn/sqs-queues.ts";
import {
	createSiteHostedChatDependencies,
	createSiteHostedProbeHandler,
	createSiteHostedRunHandler,
	siteHostedChatResourcesFromEnvironment,
	type SiteHostedChatClients,
	type SiteHostedChatEnvironment,
} from "../src/runtime/site-hosted-chat.ts";

const environment: SiteHostedChatEnvironment = {
	PAPYRUS_CHAT_MESSAGING_TABLE: "PapyrusChatMessages",
	PAPYRUS_CHAT_CONVERSATIONS_TABLE: "PapyrusChatIndex",
	PAPYRUS_CHAT_SESSION_BUCKET: "papyrus-chat-sessions",
	PAPYRUS_CHAT_TURN_RUNS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/111111111111/chat-runs",
	PAPYRUS_CHAT_TURN_PROBES_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/111111111111/chat-probes",
	PAPYRUS_CHAT_PRIVATE_BOT_ID: "papyrus-newsroom",
	PAPYRUS_CHAT_PRIVATE_BOT_NAME: "Papyrus newsroom assistant",
	OPENAI_API_KEY_PARAMETER: "/amplify/shared/papyrus/OPENAI_API_KEY",
	OPENAI_API_KEY: "unit-test-placeholder",
};

const clients: SiteHostedChatClients = {
	dynamo: {} as DynamoDBClient,
	s3: {} as S3Client,
	sqs: { send: async () => ({}) } as unknown as SQSClient,
	parameters: { send: async () => ({}) } as unknown as SSMClient,
};

describe("site-hosted chat runtime composition", () => {
	it("requires every private resource and assistant setting instead of falling back to shared resources", () => {
		expect(siteHostedChatResourcesFromEnvironment(environment)).toEqual({
			messagingTableName: "PapyrusChatMessages",
			conversationsTableName: "PapyrusChatIndex",
			sessionBucket: "papyrus-chat-sessions",
			turnRunsQueueUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/chat-runs",
			turnProbesQueueUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/chat-probes",
			assistantBotId: "papyrus-newsroom",
			assistantBotName: "Papyrus newsroom assistant",
			openAiApiKeyParameter: "/amplify/shared/papyrus/OPENAI_API_KEY",
		});
		expect(() => siteHostedChatResourcesFromEnvironment({ ...environment, PAPYRUS_CHAT_SESSION_BUCKET: "" })).toThrow(
			/PAPYRUS_CHAT_SESSION_BUCKET is required/,
		);
		expect(() => siteHostedChatResourcesFromEnvironment({ ...environment, PAPYRUS_CHAT_PRIVATE_BOT_NAME: undefined })).toThrow(
			/PAPYRUS_CHAT_PRIVATE_BOT_NAME is required/,
		);
	});

	it("composes the existing production stores and queues without sending AWS requests", () => {
		const resources = siteHostedChatResourcesFromEnvironment(environment);
		const dependencies = createSiteHostedChatDependencies(resources, clients);
		expect(dependencies.messages.store).toBeInstanceOf(DynamoMessagingStore);
		expect(dependencies.messages.turns).toBeInstanceOf(DynamoTurnAdmission);
		expect(dependencies.messages.turnRuns).toBeInstanceOf(SqsTurnRunQueue);
		expect(dependencies.messages.turnProbes).toBeInstanceOf(SqsTurnProbeQueue);
		expect(dependencies.turns.store).toBeInstanceOf(DynamoTurnControlStore);
		expect(dependencies.privateConversation?.assistantBotId).toBe("papyrus-newsroom");
	});

	it("builds the run and probe Lambda handlers using the shared computerless worker core", async () => {
		const run = createSiteHostedRunHandler(environment, clients);
		const probe = createSiteHostedProbeHandler(environment, clients);
		await run({ Records: [] }, { getRemainingTimeInMillis: () => 30_000 });
		await probe({ Records: [] });
	});
});
