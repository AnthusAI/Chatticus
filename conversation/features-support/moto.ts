import { BeforeAll } from "@cucumber/cucumber";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createPiSessionTable, createPiSessionBucket } from "../src/storage/table-definition.ts";

const MESSAGING_TABLE_NAME = "Messaging";
const CONVERSATIONS_TABLE_NAME = "Conversations";
const PI_SESSIONS_BUCKET_NAME = "PiSessions";

let motoInitialized = false;

/**
 * BeforeAll hook to initialize moto and create tables/bucket once per worker process.
 * This runs once before any scenarios in this worker.
 */
BeforeAll(async function () {
	if (motoInitialized) return;
	motoInitialized = true;

	const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";

	const dynamoClient = new DynamoDBClient({
		endpoint,
		region: "us-east-1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		maxAttempts: 1,
	});

	const s3Client = new S3Client({
		endpoint,
		region: "us-east-1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		maxAttempts: 1,
	});

	try {
		await createPiSessionTable(dynamoClient, MESSAGING_TABLE_NAME);
		await createPiSessionTable(dynamoClient, CONVERSATIONS_TABLE_NAME);
		await createPiSessionBucket(s3Client, PI_SESSIONS_BUCKET_NAME);
	} finally {
		dynamoClient.destroy();
		s3Client.destroy();
	}
});
