import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { MIGRATION_ENVIRONMENTS } from "../src/migration/cli.ts";
import { giveOrganizationsWithoutSpendCeilingTheDefaultCeiling } from "../src/migration/organization-spend-ceiling.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";

/**
 * Give every organization that has no monthly AWS spend ceiling the default ceiling new organizations start with. Dry run
 * unless --execute is given. Idempotent: an organization that has a ceiling is never touched.
 *
 * Usage: migrate-organization-spend-ceiling --environment {development,staging,production} [--tenant T] [--execute].
 *        Reads CHATTICUS_MESSAGING_TABLE.
 */
try {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			environment: { type: "string" },
			tenant: { type: "string" },
			execute: { type: "boolean", default: false },
		},
	});
	if (values.environment === undefined || !(MIGRATION_ENVIRONMENTS as readonly string[]).includes(values.environment)) {
		throw new Error(`--environment must be one of ${MIGRATION_ENVIRONMENTS.join(", ")}`);
	}
	const messagingTableName = (process.env.CHATTICUS_MESSAGING_TABLE ?? "").trim();
	if (messagingTableName === "") throw new Error("CHATTICUS_MESSAGING_TABLE is required.");
	const migrations = await giveOrganizationsWithoutSpendCeilingTheDefaultCeiling(
		{ store: new DynamoMessagingStore(new DynamoDBClient({}), messagingTableName) },
		{ execute: values.execute === true, ...(values.tenant === undefined ? {} : { tenantId: values.tenant }) },
	);
	for (const migration of migrations) process.stdout.write(`${migration.outcome} tenant=${migration.tenantId} name=${JSON.stringify(migration.name)}\n`);
	if (migrations.length === 0) process.stdout.write("no organization without a monthly spend ceiling\n");
	if (values.execute !== true) process.stdout.write("dry run: nothing was written; pass --execute to set the ceiling\n");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
