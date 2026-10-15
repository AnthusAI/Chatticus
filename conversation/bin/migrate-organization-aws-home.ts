import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { MIGRATION_ENVIRONMENTS } from "../src/migration/cli.ts";
import { homeEnabledOrganizationsWithoutAwsHome } from "../src/migration/organization-aws-home.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";

/**
 * Home every enabled organization that has no AWS home and no chosen setup path in the deployment account, as
 * Anthus-managed. Dry run unless --execute is given. Idempotent: an organization that has a home or a setup path is
 * never touched.
 *
 * Usage: migrate-organization-aws-home --environment {development,staging,production} [--tenant T] [--execute].
 *        Reads CHATTICUS_MESSAGING_TABLE and CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID.
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
	const deploymentAwsAccountId = (process.env.CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID ?? "").trim();
	if (deploymentAwsAccountId === "") throw new Error("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID is required.");
	const migrations = await homeEnabledOrganizationsWithoutAwsHome(
		{ store: new DynamoMessagingStore(new DynamoDBClient({}), messagingTableName) },
		{ deploymentAwsAccountId, execute: values.execute === true, ...(values.tenant === undefined ? {} : { tenantId: values.tenant }) },
	);
	for (const migration of migrations) process.stdout.write(`${migration.outcome} tenant=${migration.tenantId} name=${JSON.stringify(migration.name)}\n`);
	if (migrations.length === 0) process.stdout.write("no enabled organization without an AWS home and setup path\n");
	if (values.execute !== true) process.stdout.write("dry run: nothing was written; pass --execute to home\n");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
