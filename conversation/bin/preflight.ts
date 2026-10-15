import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { preflightInputsFromEnvironment, runPreflight } from "../src/migration/preflight.ts";

/**
 * Flip pre-flight: prints a JSON report and exits 1 unless no turn is unfinished, every TurnRuns, TurnProbes,
 * ComputerStartJobs, TurnJobs and ComputerTurnJobs queue is empty with nothing in flight, and no computer host start is
 * in flight. Exits 2 when the environment is incomplete. Reads CHATTICUS_MESSAGING_TABLE and the five queue URL
 * variables named in src/migration/preflight.ts.
 */
try {
	const inputs = preflightInputsFromEnvironment(process.env);
	const report = await runPreflight({
		dynamo: new DynamoDBClient({}),
		sqs: new SQSClient({}),
		now: () => new Date(),
		...inputs,
	});
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = report.ok ? 0 : 1;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
