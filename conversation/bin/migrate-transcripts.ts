import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { MigrationCliConfigurationError, runMigrationCli } from "../src/migration/cli.ts";

/**
 * Operator CLI for the transcript migration: copy, latest-turns, delta, verify and the write gate.
 * Reads the Messaging table, the Conversations table and the PiSessions bucket from the environment.
 */
const required = (name: string): string => {
	const value = (process.env[name] ?? "").trim();
	if (value === "") throw new MigrationCliConfigurationError(`${name} is required.`);
	return value;
};

const result = await runMigrationCli(process.argv.slice(2), {
	build: () => ({
		client: new DynamoDBClient({}),
		s3: new S3Client({ forcePathStyle: process.env.AWS_ENDPOINT_URL !== undefined }),
		messagingTableName: required("CHATTICUS_MESSAGING_TABLE"),
		conversationsTableName: required("CHATTICUS_CONVERSATIONS_TABLE"),
		bucket: required("CHATTICUS_PI_SESSIONS_BUCKET"),
		clock: { now: () => new Date() },
	}),
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
