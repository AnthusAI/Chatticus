import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createContainerOwnerDeps,
	ownerIdentityFromEnvironment,
	ownerStoresConfigFromEnvironment,
	ownerTurnJobFromEnvironment,
} from "./owner-deps.ts";
import {
	CHILD_EXIT_CONFIGURATION,
	DEFAULT_SHELL_LAUNCHER_PATH,
	DEFAULT_WORKSPACE_ROOT,
	observeOwnerTurn,
	ownerChildExitCodeForError,
	ownerExitCodeFor,
	ownerLogEmitter,
	runFileProbe,
	runLiveFileProbe,
	runOverlayProbe,
	type LiveFileProbeKind,
	runOwnerEntryPoint,
	runShellProbe,
} from "./owner.ts";

const workspaceRoot = (process.env["CHATTICUS_WORKSPACE_ROOT"] ?? "").trim() || DEFAULT_WORKSPACE_ROOT;
const fileHelperCommand = [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "file-helper.mjs")];
const shellLauncherPath = (process.env["CHATTICUS_SHELL_LAUNCHER"] ?? "").trim() || DEFAULT_SHELL_LAUNCHER_PATH;

/**
 * Entry point of the per-turn container owner program, started by the supervisor with a subcommand.
 *
 * `turn` takes over the one turn the supervisor dispatched, named in the environment the supervisor built (tenant, turn, bot,
 * dispatch, owner id, the member, the gateway token and the AWS credentials of that one conversation): it runs the turn under
 * the supervisor's owner id with model-chosen commands started through the shell launcher, writes the turn's lines and one
 * `owner_exit` line, and exits 0 for a turn that reached a terminal state or was parked or yielded for another owner, 1 for a
 * lost claim race or a turn left for reconciliation, 2 for wrong settings, 3 for an unusable shell launcher and 70 for an
 * uncaught exception. The disk is not this program's: the supervisor hydrated it and publishes it.
 *
 * `shell-probe <command>` runs one command through the shell launcher and prints what it left, so an image can show what the
 * unprivileged shell reaches. `file-probe <read_workspace|write_workspace|edit_workspace> <path> [text [new text]]` runs one
 * file tool as the owner runs it and prints `file_probe_ok` or `file_probe_error` and the tool's answer.
 * `live-file-probe <list|read|write|stat|delete|mkdir> <path> [text [expected sha256]]` runs one live file operation as the
 * supervisor runs it for a member and prints `live_file_probe_ok` or `live_file_probe_error` and the outcome as JSON.
 * `overlay-probe <entries.json> <blobs-directory>` applies overlay entries as the supervisor applies the sealed overlay after a hydrate
 * and prints `overlay_probe_ok` and what it applied and reported as conflicts as JSON. Any other argument exits 2.
 *
 * Every line names the event and carries the tenant, turn and owner id and none carries a token, a credential, a key, a tool's
 * arguments or its output.
 *
 * @param argv The arguments after the program name.
 * @returns The process exit code.
 */
export async function ownerMain(argv: readonly string[]): Promise<number> {
	if (argv[0] === "shell-probe") {
		const result = await runShellProbe(argv[1] ?? "true", { workspaceRoot, shellLauncherPath });
		process.stdout.write(result.output);
		return result.exitCode;
	}
	if (argv[0] === "file-probe") {
		const [, tool, path = "", first = "", second = ""] = argv;
		const args: Record<string, string> = tool === "write_workspace" ? { path, content: first } : tool === "edit_workspace" ? { path, old_text: first, new_text: second } : { path };
		const result = await runFileProbe(tool as "read_workspace" | "write_workspace" | "edit_workspace", args, { workspaceRoot, shellLauncherPath, fileHelperCommand });
		process.stdout.write(`${result.isError ? "file_probe_error" : "file_probe_ok"}: ${result.text}\n`);
		return result.isError ? 1 : 0;
	}
	if (argv[0] === "live-file-probe") {
		const [, kind = "", path = "", text = "", expectedSha256 = ""] = argv;
		const outcome = await runLiveFileProbe(kind as LiveFileProbeKind, path, text, expectedSha256, { workspaceRoot, shellLauncherPath, fileHelperCommand });
		process.stdout.write(`${outcome.status === "ok" ? "live_file_probe_ok" : `live_file_probe_error ${outcome.code}`} ${JSON.stringify(outcome)}\n`);
		return outcome.status === "ok" ? 0 : 1;
	}
	if (argv[0] === "overlay-probe") {
		const [, entriesFile = "", blobsDirectory = ""] = argv;
		try {
			const result = await runOverlayProbe(entriesFile, blobsDirectory, { workspaceRoot, shellLauncherPath, fileHelperCommand });
			process.stdout.write(`overlay_probe_ok ${JSON.stringify(result)}\n`);
			return 0;
		} catch (error) {
			process.stdout.write(`overlay_probe_error ${error instanceof Error ? error.name : "unknown"}\n`);
			return 1;
		}
	}
	if (argv[0] !== "turn") {
		console.error("owner_unknown_subcommand");
		return CHILD_EXIT_CONFIGURATION;
	}
	try {
		const identity = ownerIdentityFromEnvironment();
		const { job } = ownerTurnJobFromEnvironment();
		const stores = ownerStoresConfigFromEnvironment();
		const log = ownerLogEmitter({ tenantId: identity.tenantId, turnId: job.turnId, ownerId: identity.ownerId });
		process.umask(0o002);
		const outcome = await observeOwnerTurn(log, () =>
			runOwnerEntryPoint(job, createContainerOwnerDeps(stores, log), { workspaceRoot, shellLauncherPath, fileHelperCommand, workerId: identity.ownerId }),
		);
		console.info(`owner_outcome=${outcome} tenant_id=${job.tenantId} turn_id=${job.turnId}`);
		return ownerExitCodeFor(outcome);
	} catch (error) {
		const code = ownerChildExitCodeForError(error);
		console.error(`owner_turn_failed code=${code} error_name=${error instanceof Error ? error.name : "unknown"}`);
		return code;
	}
}

if (import.meta.main) {
	process.exitCode = await ownerMain(process.argv.slice(2));
}
