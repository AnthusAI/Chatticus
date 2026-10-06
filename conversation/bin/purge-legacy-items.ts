import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { MIGRATION_ENVIRONMENTS } from "../src/migration/cli.ts";
import { DEFAULT_PURGE_MINIMUM_AGE_DAYS, purgeLegacyItems } from "../src/migration/purge.ts";

/**
 * Day-14 purge of the Python-era message items of migrated channels. Dry run unless --execute is given. Only channels
 * the migration verified (the VERIFIED# marker) and only items the marker covers are ever deleted.
 *
 * Usage: purge-legacy-items --environment {development,staging,production} [--tenant T] [--channel C]
 *        [--minimum-age-days N] [--execute]. Reads CHATTICUS_MESSAGING_TABLE.
 */
try {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			environment: { type: "string" },
			tenant: { type: "string" },
			channel: { type: "string" },
			execute: { type: "boolean", default: false },
			"minimum-age-days": { type: "string", default: String(DEFAULT_PURGE_MINIMUM_AGE_DAYS) },
		},
	});
	if (values.environment === undefined || !(MIGRATION_ENVIRONMENTS as readonly string[]).includes(values.environment)) {
		throw new Error(`--environment must be one of ${MIGRATION_ENVIRONMENTS.join(", ")}`);
	}
	const minimumAgeDays = Number(values["minimum-age-days"]);
	if (!Number.isFinite(minimumAgeDays) || minimumAgeDays < 0) throw new Error("--minimum-age-days must be a number of days");
	const messagingTableName = (process.env.CHATTICUS_MESSAGING_TABLE ?? "").trim();
	if (messagingTableName === "") throw new Error("CHATTICUS_MESSAGING_TABLE is required.");
	const results = await purgeLegacyItems(
		{ client: new DynamoDBClient({}), messagingTableName, clock: { now: () => new Date() } },
		{
			...(values.tenant === undefined ? {} : { tenantId: values.tenant }),
			...(values.channel === undefined ? {} : { channelId: values.channel }),
		},
		{ execute: values.execute === true, minimumAgeDays },
	);
	for (const result of results) {
		process.stdout.write(
			`${result.outcome} tenant=${result.tenantId} channel=${result.channelId} items=${result.items}` +
				`${result.reason === undefined ? "" : ` reason=${JSON.stringify(result.reason)}`}\n`,
		);
	}
	if (values.execute !== true) process.stdout.write("dry run: nothing was deleted; pass --execute to delete\n");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
