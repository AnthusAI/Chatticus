import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { MIGRATION_ENVIRONMENTS } from "../src/migration/cli.ts";
import { moveComputerRecords } from "../src/migration/computer-record.ts";

/**
 * Move each organization's computer record from `<tenant>#roster` (sort key `computer`) to `<tenant>#computer#record`.
 * Dry run unless --execute is given. Idempotent: a record already at the new key is never overwritten.
 *
 * Usage: migrate-computer-record --environment {development,staging,production} [--tenant T] [--execute].
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
	const moves = await moveComputerRecords(
		{ client: new DynamoDBClient({}), messagingTableName },
		{ execute: values.execute === true, ...(values.tenant === undefined ? {} : { tenantId: values.tenant }) },
	);
	for (const move of moves) process.stdout.write(`${move.outcome} tenant=${move.tenantId}\n`);
	if (moves.length === 0) process.stdout.write("no computer record at the old key\n");
	if (values.execute !== true) process.stdout.write("dry run: nothing was written; pass --execute to move\n");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
