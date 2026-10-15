import { parseArgs } from "node:util";
import { type CopyPhase, type MigrationDependencies, copyAllChannels } from "./copy.ts";
import { convertLatestTurns } from "./latest-turns.ts";
import type { MigrationScope } from "./legacy-layout.ts";
import { DynamoWriteGate } from "./migration-state.ts";
import { verifyAll } from "./verify.ts";

/** The named cloud environments the tool runs against. */
export const MIGRATION_ENVIRONMENTS = ["development", "staging", "production"] as const;

/** Raised when the process environment cannot support the command; exit code 2. */
export class MigrationCliConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MigrationCliConfigurationError";
	}
}

/** Everything the CLI needs from its process. */
export type MigrationCliDependencies = {
	/** Builds the clients and table names for an environment; throws MigrationCliConfigurationError when incomplete. */
	build: (environment: string) => MigrationDependencies;
};

/** Captured result of one CLI invocation. */
export type MigrationCliResult = { exitCode: number; stdout: string; stderr: string };

/** What the operator is told after every writing pass: nothing old was changed that the old system needs. */
export const ROLLBACK_NOTE =
	"rollback: the old message, turn, event and pointer items were not deleted; reverting the flip commit serves the old system again. The purge follow-up removes them after day 14.";

const USAGE = `usage: migrate-transcripts <command> --environment {development,staging,production} [options]

commands:
  copy          Copy the old transcripts into per-(bot, channel) Pi sessions. Repeatable and idempotent.
  latest-turns  Rewrite turn records into the new shape and write the latest-turn pointers.
  delta         With the write gate closed: copy what was posted since the last copy, convert the turns (failing any
                still active), then verify. Needs the write gate closed.
  verify        Compare the old items with the new read paths. Exit 1 on any difference.
  gate          gate close | gate open | gate status: the write gate the front door honors.

options:
  --environment   Required. development, staging or production.
  --tenant        Only this organization.
  --channel       Only this channel.
  --dry-run       Report counts and what would be written; write nothing (copy, latest-turns).

Resources come from CHATTICUS_MESSAGING_TABLE, CHATTICUS_CONVERSATIONS_TABLE and CHATTICUS_PI_SESSIONS_BUCKET.
`;

class CliUsageError extends Error {}

async function runCopyPhase(
	deps: MigrationDependencies,
	scope: MigrationScope,
	phase: CopyPhase,
	dryRun: boolean,
	out: string[],
): Promise<boolean> {
	let failed = false;
	const results = await copyAllChannels(deps, scope, { phase, dryRun });
	for (const result of results) {
		if (result.report === null) {
			failed = true;
			out.push(`${phase} tenant=${result.tenantId} channel=${result.channelId} FAILED ${result.error?.message}`);
			continue;
		}
		const report = result.report;
		const pending = report.sessions.reduce((sum, session) => sum + session.pending, 0);
		const written = report.sessions.reduce((sum, session) => sum + session.written, 0);
		const assistant = report.sessions.reduce((sum, session) => sum + session.pendingAssistantEntries, 0);
		const attributed = report.sessions.reduce((sum, session) => sum + session.pendingAttributedEntries, 0);
		const verb = dryRun ? "dry-run" : phase;
		out.push(
			`${verb} tenant=${report.tenantId} channel=${report.channelId} bots=${report.botIds.length} messages=${report.legacyMessages}` +
				` ${dryRun ? `would_write=${pending}` : `written=${written}`} assistant_entries=${assistant} attributed_entries=${attributed}` +
				`${report.unservable ? " UNSERVABLE=no_bot_participant" : ""}`,
		);
		if (report.unservable) failed = true;
	}
	const totalMessages = results.reduce((sum, result) => sum + (result.report?.legacyMessages ?? 0), 0);
	out.push(`${dryRun ? "dry-run" : phase} channels=${results.length} messages=${totalMessages}`);
	return !failed;
}

async function runLatestTurns(
	deps: MigrationDependencies,
	scope: MigrationScope,
	failActive: boolean,
	dryRun: boolean,
	out: string[],
): Promise<void> {
	for (const report of await convertLatestTurns(
		{ client: deps.client, messagingTableName: deps.messagingTableName, clock: deps.clock },
		scope,
		{ dryRun, failActive },
	)) {
		out.push(
			`${dryRun ? "dry-run" : "latest-turns"} tenant=${report.tenantId} channel=${report.channelId} turns=${report.turns}` +
				` converted=${report.converted} already=${report.alreadyConverted} active_failed=${report.activeFailed}` +
				` active_left=${report.activeLeft} pointers=${report.pointersWritten}`,
		);
	}
}

async function runVerify(deps: MigrationDependencies, scope: MigrationScope, out: string[]): Promise<boolean> {
	let ok = true;
	for (const result of await verifyAll(deps, scope)) {
		out.push(
			`verify tenant=${result.tenantId} channel=${result.channelId} ${result.ok ? "ok" : "FAILED"} old=${result.legacyMessages} listed=${result.listedMessages}`,
		);
		for (const failure of result.failures) out.push(`  ${failure}`);
		if (!result.ok) ok = false;
	}
	return ok;
}

/**
 * Run the migration CLI.
 *
 * @param argv Arguments after the program name.
 * @param dependencies How to build the clients for the named environment.
 * @returns Exit code (0 done, 1 a pass failed or verification found a difference, 2 usage or configuration), stdout and stderr.
 */
export async function runMigrationCli(argv: string[], dependencies: MigrationCliDependencies): Promise<MigrationCliResult> {
	const out: string[] = [];
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				environment: { type: "string" },
				tenant: { type: "string" },
				channel: { type: "string" },
				"dry-run": { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
		const [command, subcommand] = positionals;
		if (values.help || command === undefined) return { exitCode: values.help ? 0 : 2, stdout: values.help ? USAGE : "", stderr: values.help ? "" : USAGE };
		if (!["copy", "latest-turns", "delta", "verify", "gate"].includes(command)) throw new CliUsageError(`unknown command ${command}`);
		const environment = values.environment;
		if (environment === undefined || !(MIGRATION_ENVIRONMENTS as readonly string[]).includes(environment)) {
			throw new CliUsageError(`--environment must be one of ${MIGRATION_ENVIRONMENTS.join(", ")}`);
		}
		const scope: MigrationScope = { tenantId: values.tenant, channelId: values.channel };
		const deps = dependencies.build(environment);
		const gate = new DynamoWriteGate(deps.client, deps.messagingTableName);
		const dryRun = values["dry-run"] === true;
		let ok = true;
		if (command === "gate") {
			if (subcommand === "close" || subcommand === "open") {
				await gate.set(subcommand === "close" ? "MIGRATING" : "OPEN", deps.clock.now());
			} else if (subcommand !== "status") {
				throw new CliUsageError("gate takes close, open or status");
			}
			out.push(`gate ${await gate.state()}`);
		} else if (command === "copy") {
			ok = await runCopyPhase(deps, scope, "copy", dryRun, out);
			if (!dryRun) out.push(ROLLBACK_NOTE);
		} else if (command === "latest-turns") {
			await runLatestTurns(deps, scope, (await gate.state()) === "MIGRATING", dryRun, out);
			if (!dryRun) out.push(ROLLBACK_NOTE);
		} else if (command === "delta") {
			if ((await gate.state()) !== "MIGRATING") {
				throw new MigrationCliConfigurationError("delta needs the write gate closed; run `gate close` first so no message lands during the pass");
			}
			ok = await runCopyPhase(deps, scope, "delta", dryRun, out);
			await runLatestTurns(deps, scope, true, dryRun, out);
			if (!dryRun) {
				ok = (await runVerify(deps, scope, out)) && ok;
				out.push(ROLLBACK_NOTE);
			}
		} else {
			ok = await runVerify(deps, scope, out);
		}
		return { exitCode: ok ? 0 : 1, stdout: `${out.join("\n")}\n`, stderr: "" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof CliUsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
			return { exitCode: 2, stdout: `${out.join("\n")}${out.length === 0 ? "" : "\n"}`, stderr: `${message}\n\n${USAGE}` };
		}
		if (error instanceof MigrationCliConfigurationError) {
			return { exitCode: 2, stdout: `${out.join("\n")}${out.length === 0 ? "" : "\n"}`, stderr: `${message}\n` };
		}
		return { exitCode: 1, stdout: `${out.join("\n")}${out.length === 0 ? "" : "\n"}`, stderr: `${message}\n` };
	}
}
