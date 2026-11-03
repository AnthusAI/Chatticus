import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoChannelStore } from "../src/store/channel-store.ts";
import { CHANNELS_MAIL_DOMAIN_VARIABLE } from "../src/lambdas/channels-composition.ts";
import { MembersCliConfigurationError, runMembersCli } from "../src/members/cli.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";

/**
 * Administrator CLI: list, inspect, and mutate organization records.
 * Reads the messaging table name from CHATTICUS_MESSAGING_TABLE and, for the mail commands, the mail domain from CHATTICUS_CHANNELS_MAIL_DOMAIN.
 */
function messagingTableName(): string {
	const tableName = (process.env.CHATTICUS_MESSAGING_TABLE ?? "").trim();
	if (tableName === "") {
		throw new MembersCliConfigurationError("CHATTICUS_MESSAGING_TABLE is required.");
	}
	return tableName;
}

const result = await runMembersCli(process.argv.slice(2), {
	buildStore: () => new DynamoMessagingStore(new DynamoDBClient({}), messagingTableName()),
	buildBindingRuntime: () => {
		const mailDomain = (process.env[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? "").trim();
		if (mailDomain === "") {
			throw new MembersCliConfigurationError(`${CHANNELS_MAIL_DOMAIN_VARIABLE} is required for the mail commands.`);
		}
		return {
			store: new DynamoChannelStore(new DynamoDBClient({}), messagingTableName()),
			mailDomain,
			allowedProviders: ["email"],
		};
	},
	clock: { now: () => new Date() },
	ids: { next: () => randomUUID() },
	stdinIsTerminal: process.stdin.isTTY === true,
	callerAwsAccountId: async () => {
		const identity = await new STSClient({}).send(new GetCallerIdentityCommand({}));
		const accountId = (identity.Account ?? "").trim();
		if (accountId === "") {
			throw new MembersCliConfigurationError("STS GetCallerIdentity did not return an AWS account id.");
		}
		return accountId;
	},
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
