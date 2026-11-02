import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoTurnAdmission } from "../store/turn-admission-store.ts";
import { DynamoTurnControlStore } from "../store/turn-store.ts";
import { MessageBodyCache } from "../pi/message-cache.ts";
import { PiSubmissionInspector } from "../pi/submission-inspector.ts";
import { consumeRunJob } from "../turn/executor.ts";
import { createOpenAiModels, DEFAULT_TURN_MODEL } from "../turn/openai-models.ts";
import { SqsRunVisibility, SqsTurnProbeQueue, SqsTurnRunQueue } from "../turn/sqs-queues.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../turn/types.ts";
import type { ComputerHandoffDependencies } from "../turn/park.ts";
import { handleProbe, type ProbeDependencies } from "../turn/probes.ts";
import type { TurnProbeMessage } from "../domain/turn-admission.ts";
import { defaultVendorPriceBook } from "../ledger/vendor-prices.ts";
import { resolveOpenAiApiKey, type ParameterReader } from "../lambdas/openai-key.ts";
import { createEmbeddedChatApp, type EmbeddedChatAppDependencies } from "../http/embedded-chat-app.ts";

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
	readonly parameters: ParameterReader;
};

export type SiteHostedChatEnvironment = Record<string, string | undefined>;

export type SiteHostedRunRecord = { readonly body: string; readonly receiptHandle: string };
export type SiteHostedProbeRecord = { readonly body: string };

const RESOURCE_ENVIRONMENT_KEYS = {
	messagingTableName: "PAPYRUS_CHAT_MESSAGING_TABLE",
	conversationsTableName: "PAPYRUS_CHAT_CONVERSATIONS_TABLE",
	sessionBucket: "PAPYRUS_CHAT_SESSION_BUCKET",
	turnRunsQueueUrl: "PAPYRUS_CHAT_TURN_RUNS_QUEUE_URL",
	turnProbesQueueUrl: "PAPYRUS_CHAT_TURN_PROBES_QUEUE_URL",
	assistantBotId: "PAPYRUS_CHAT_PRIVATE_BOT_ID",
	assistantBotName: "PAPYRUS_CHAT_PRIVATE_BOT_NAME",
	openAiApiKeyParameter: "OPENAI_API_KEY_PARAMETER",
} as const;

function unavailableCapability(): never {
	throw new Error("Computer capability is unavailable in the site-hosted computerless runtime.");
}

const unavailableStore = new Proxy({}, { get: unavailableCapability });
const computerlessHandoff: ComputerHandoffDependencies = {
	actions: unavailableStore as ComputerHandoffDependencies["actions"],
	computerStarts: unavailableStore as ComputerHandoffDependencies["computerStarts"],
	rollups: unavailableStore as ComputerHandoffDependencies["rollups"],
	environment: "site-hosted-computerless",
	heartbeatTimeoutSeconds: 60,
};

function required(environment: SiteHostedChatEnvironment, key: string): string {
	const value = environment[key]?.trim();
	if (value === undefined || value === "") throw new Error(`The environment variable ${key} is required.`);
	return value;
}

export function siteHostedChatResourcesFromEnvironment(environment: SiteHostedChatEnvironment): SiteHostedChatResources {
	return {
		messagingTableName: required(environment, RESOURCE_ENVIRONMENT_KEYS.messagingTableName),
		conversationsTableName: required(environment, RESOURCE_ENVIRONMENT_KEYS.conversationsTableName),
		sessionBucket: required(environment, RESOURCE_ENVIRONMENT_KEYS.sessionBucket),
		turnRunsQueueUrl: required(environment, RESOURCE_ENVIRONMENT_KEYS.turnRunsQueueUrl),
		turnProbesQueueUrl: required(environment, RESOURCE_ENVIRONMENT_KEYS.turnProbesQueueUrl),
		assistantBotId: required(environment, RESOURCE_ENVIRONMENT_KEYS.assistantBotId),
		assistantBotName: required(environment, RESOURCE_ENVIRONMENT_KEYS.assistantBotName),
		...(environment[RESOURCE_ENVIRONMENT_KEYS.openAiApiKeyParameter]
			? { openAiApiKeyParameter: environment[RESOURCE_ENVIRONMENT_KEYS.openAiApiKeyParameter] }
			: {}),
	};
}

export function siteHostedChatClients(): SiteHostedChatClients {
	return {
		dynamo: new DynamoDBClient({}),
		s3: new S3Client({}),
		sqs: new SQSClient({}),
		parameters: new SSMClient({}),
	};
}

function now(): Date {
	return new Date();
}

export function createSiteHostedChatDependencies(
	resources: SiteHostedChatResources,
	clients: SiteHostedChatClients,
	clock: { now(): Date } = { now },
): EmbeddedChatAppDependencies {
	const messaging = new DynamoMessagingStore(clients.dynamo, resources.messagingTableName);
	const runQueue = new SqsTurnRunQueue(clients.sqs, resources.turnRunsQueueUrl);
	const probeQueue = new SqsTurnProbeQueue(clients.sqs, resources.turnProbesQueueUrl);
	return {
		clock,
		messages: {
			store: messaging,
			ids: { next: () => randomUUID() },
			clock,
			mailbox: { client: clients.dynamo, tableName: resources.messagingTableName },
			turns: new DynamoTurnAdmission(clients.dynamo, resources.messagingTableName),
			turnRuns: runQueue,
			turnProbes: probeQueue,
			listing: {
				client: clients.dynamo,
				s3: clients.s3,
				messagingTableName: resources.messagingTableName,
				conversationsTableName: resources.conversationsTableName,
				bucket: resources.sessionBucket,
				commitCache: new MessageBodyCache<Promise<import("../storage/indexed-storage.ts").CommitObject>>(),
			},
		},
		turns: {
			store: new DynamoTurnControlStore(clients.dynamo, resources.messagingTableName),
			clock,
			ids: { next: () => randomUUID() },
		},
		resolvePrincipal: async () => null,
		privateConversation: {
			assistantBotId: resources.assistantBotId,
			ensureAssistant: async (tenantId) => {
				if (await messaging.getBot(tenantId, resources.assistantBotId)) return;
				const namedBot = await messaging.getBotByName(tenantId, resources.assistantBotName);
				if (namedBot && namedBot.botId !== resources.assistantBotId) {
					throw new Error("The configured private assistant name belongs to a different bot.");
				}
				try {
					await messaging.putBot({ botId: resources.assistantBotId, tenantId, name: resources.assistantBotName, memory: {} }, true);
				} catch (error) {
					if (!(await messaging.getBot(tenantId, resources.assistantBotId))) throw error;
				}
			},
		},
	};
}

function jobFrom(record: SiteHostedRunRecord): TurnExecutionJob {
	const job = JSON.parse(record.body) as Record<string, unknown>;
	const { tenantId, turnId, botId } = job;
	if (typeof tenantId !== "string" || typeof turnId !== "string" || typeof botId !== "string") {
		throw new Error("A TurnRuns message must name tenantId, turnId and botId.");
	}
	return { tenantId, turnId, botId };
}

function probeFrom(record: SiteHostedProbeRecord): TurnProbeMessage {
	const message = JSON.parse(record.body) as Record<string, unknown>;
	const { tenantId, turnId, kind, expectAttempt } = message;
	if (typeof tenantId !== "string" || typeof turnId !== "string" || kind !== "deadline" || typeof expectAttempt !== "number") {
		throw new Error("A TurnProbes message must name tenantId, turnId, kind deadline and expectAttempt.");
	}
	return { tenantId, turnId, kind, expectAttempt };
}

export function createSiteHostedRunHandler(
	environment: SiteHostedChatEnvironment,
	clients: SiteHostedChatClients = siteHostedChatClients(),
): (event: { Records: readonly SiteHostedRunRecord[] }, context: { getRemainingTimeInMillis(): number }) => Promise<void> {
	const resources = siteHostedChatResourcesFromEnvironment(environment);
	let dependencies: Omit<ExecutorDeps, "runVisibility" | "remainingMilliseconds"> | undefined;
	const getDependencies = async () => {
		if (dependencies) return dependencies;
		if (environment.OPENAI_API_KEY === undefined || environment.OPENAI_API_KEY === "") {
			if (resources.openAiApiKeyParameter) environment.OPENAI_API_KEY_PARAMETER = resources.openAiApiKeyParameter;
			await resolveOpenAiApiKey(environment, clients.parameters);
		}
		if (!environment.OPENAI_API_KEY) throw new Error("An OpenAI API key is required by the hosted chat worker.");
		const messaging = new DynamoMessagingStore(clients.dynamo, resources.messagingTableName);
		dependencies = {
			turns: {
				store: new DynamoTurnControlStore(clients.dynamo, resources.messagingTableName),
				clock: { now },
				ids: { next: () => randomUUID() },
			},
			messaging,
			client: clients.dynamo,
			s3: clients.s3,
			messagingTableName: resources.messagingTableName,
			conversationsTableName: resources.conversationsTableName,
			piSessionsBucket: resources.sessionBucket,
			models: createOpenAiModels(),
			model: DEFAULT_TURN_MODEL,
			ledger: { client: clients.dynamo, tableName: resources.messagingTableName, prices: defaultVendorPriceBook(), now },
			ownerKind: "lambda",
			workerLabel: "papyrus-private-chat-run-worker",
			turnRuns: new SqsTurnRunQueue(clients.sqs, resources.turnRunsQueueUrl),
			turnProbes: new SqsTurnProbeQueue(clients.sqs, resources.turnProbesQueueUrl),
			computer: computerlessHandoff,
			executionProfile: "computerless",
		};
		return dependencies;
	};
	return async (event, context) => {
		for (const record of event.Records) {
			const shared = await getDependencies();
			await consumeRunJob(
				jobFrom(record),
				{
					...shared,
					runVisibility: new SqsRunVisibility(clients.sqs, resources.turnRunsQueueUrl, record.receiptHandle),
					remainingMilliseconds: () => context.getRemainingTimeInMillis(),
				},
				async () => undefined,
			);
		}
	};
}

export function createSiteHostedProbeHandler(
	environment: SiteHostedChatEnvironment,
	clients: SiteHostedChatClients = siteHostedChatClients(),
): (event: { Records: readonly SiteHostedProbeRecord[] }) => Promise<void> {
	const resources = siteHostedChatResourcesFromEnvironment(environment);
	const turns = {
		store: new DynamoTurnControlStore(clients.dynamo, resources.messagingTableName),
		clock: { now },
		ids: { next: () => randomUUID() },
	};
	const dependencies: ProbeDependencies = {
		turns,
		turnRuns: new SqsTurnRunQueue(clients.sqs, resources.turnRunsQueueUrl),
		turnProbes: new SqsTurnProbeQueue(clients.sqs, resources.turnProbesQueueUrl),
		messaging: new DynamoMessagingStore(clients.dynamo, resources.messagingTableName),
		submissions: new PiSubmissionInspector({
			client: clients.dynamo,
			s3: clients.s3,
			tableName: resources.conversationsTableName,
			bucket: resources.sessionBucket,
		}),
	};
	return async (event) => {
		for (const record of event.Records) await handleProbe(dependencies, probeFrom(record));
	};
}

export function createSiteHostedChatApp(
	environment: SiteHostedChatEnvironment,
	resolvePrincipal: EmbeddedChatAppDependencies["resolvePrincipal"],
	clients: SiteHostedChatClients = siteHostedChatClients(),
): ReturnType<typeof createEmbeddedChatApp> {
	const dependencies = createSiteHostedChatDependencies(siteHostedChatResourcesFromEnvironment(environment), clients);
	return createEmbeddedChatApp({ ...dependencies, resolvePrincipal });
}
