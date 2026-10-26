import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MessageDependencies } from "../domain/messages.ts";
import type { ChannelListingDependencies } from "../pi/channel-listing.ts";
import { MessageBodyCache } from "../pi/message-cache.ts";
import type { CommitObject } from "../storage/indexed-storage.ts";
import { DynamoTurnAdmission } from "../store/turn-admission-store.ts";
import { SqsTurnProbeQueue, SqsTurnRunQueue } from "../turn/sqs-queues.ts";

/** The environment variable that is required and empty or absent fails composition with a message that names it. */
export function requiredVariable(environment: Record<string, string | undefined>, name: string): string {
	const value = environment[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
}

/**
 * The stores and queues message admission reads and writes, built from the deployment's environment. The front door and the
 * mail ingress function admit messages through exactly this composition.
 *
 * @param environment The environment variables.
 * @param clients The DynamoDB, S3 and SQS clients.
 * @param messagingTableName The Messaging table.
 * @returns Everything message admission needs except the store, the id source and the clock.
 * @throws Error If a required variable is missing.
 */
export function composeMessageDependencies(
	environment: Record<string, string | undefined>,
	clients: { readonly dynamo: DynamoDBClient; readonly s3: S3Client; readonly sqs: SQSClient },
	messagingTableName: string,
): Omit<MessageDependencies, "store" | "ids" | "clock"> {
	return {
		mailbox: { client: clients.dynamo, tableName: messagingTableName },
		turns: new DynamoTurnAdmission(clients.dynamo, messagingTableName),
		turnRuns: new SqsTurnRunQueue(clients.sqs, requiredVariable(environment, "CHATTICUS_TURN_RUNS_QUEUE_URL")),
		turnProbes: new SqsTurnProbeQueue(clients.sqs, requiredVariable(environment, "CHATTICUS_TURN_PROBES_QUEUE_URL")),
		listing: composeChannelListing(environment, clients, messagingTableName),
	};
}

/**
 * What reading a channel's committed messages needs, built from the deployment's environment.
 *
 * @param environment The environment variables.
 * @param clients The DynamoDB and S3 clients.
 * @param messagingTableName The Messaging table.
 * @returns The listing dependencies.
 * @throws Error If a required variable is missing.
 */
export function composeChannelListing(
	environment: Record<string, string | undefined>,
	clients: { readonly dynamo: DynamoDBClient; readonly s3: S3Client },
	messagingTableName: string,
): ChannelListingDependencies {
	return {
		client: clients.dynamo,
		s3: clients.s3,
		messagingTableName,
		conversationsTableName: requiredVariable(environment, "CHATTICUS_CONVERSATIONS_TABLE"),
		bucket: requiredVariable(environment, "CHATTICUS_PI_SESSIONS_BUCKET"),
		commitCache: new MessageBodyCache<Promise<CommitObject>>(),
	};
}
