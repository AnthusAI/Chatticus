import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_START_GENERATION_VARIABLE } from "../../../conversation/src/computer/owner-environment.ts";
import { createContainerOwnerDeps, ownerIdentityFromEnvironment, ownerStoresConfigFromEnvironment } from "./owner-deps.ts";
import { snapshotStoreFromEnvironment } from "./disk-lifecycle.ts";
import { HostProtocolClient, registerHostWorker } from "./protocol-client.ts";
import { liveRootFromEnvironment } from "./live-root.ts";
import {
	DEFAULT_SHELL_LAUNCHER_PATH,
	DEFAULT_WORKSPACE_ROOT,
	observeOwnerRun,
	ownerExitCodeFor,
	ownerLogEmitter,
	runFileProbe,
	runOwnerEntryPoint,
	runOwnerOnComputerDisk,
	runShellProbe,
	shareWorkspaceWithShell,
	startJobSourceFromEnvironment,
} from "./owner.ts";

const workspaceRoot = (process.env["CHATTICUS_WORKSPACE_ROOT"] ?? "").trim() || DEFAULT_WORKSPACE_ROOT;
const fileHelperCommand = [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "file-helper.mjs")];
const shellLauncherPath = (process.env["CHATTICUS_SHELL_LAUNCHER"] ?? "").trim() || DEFAULT_SHELL_LAUNCHER_PATH;

/**
 * Entry point of the container owner program.
 *
 * `shell-probe <command>` runs one command through the shell launcher and prints what it left, so an image can show what
 * the unprivileged shell reaches. `file-probe <read_workspace|write_workspace|edit_workspace> <path> [text [new text]]` runs
 * one file tool as the owner runs it and prints `file_probe_ok` or `file_probe_error` and the tool's answer. With no argument the program takes over the turn the start named: no named turn ends
 * with `owner_no_job` and success. For a named turn the owner registers with the Front Door under its owner id, hydrates
 * the computer's snapshot into the workspace, runs the turn under that owner id, publishes the disk when it is dirty and
 * marks the computer stopped, then ends with `owner_outcome=<outcome>`; the exit code is 0 when the turn reached a
 * terminal state or was parked or yielded for another owner.
 *
 * Every step writes one structured line carrying the tenant, turn and owner id: `owner_started`, `workspace_hydrated`,
 * `turn_claimed` or `turn_claim_lost`, `tool_started` and `tool_finished`, `model_call`, `snapshot_published` or
 * `snapshot_skipped`, and `owner_exit`. None of them carries a token, a credential, a key, a tool's arguments or its output.
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
	const source = startJobSourceFromEnvironment();
	const job = await source.claim();
	if (job === null) {
		console.info("owner_no_job");
		return 0;
	}
	const stores = ownerStoresConfigFromEnvironment();
	const identity = ownerIdentityFromEnvironment();
	const log = ownerLogEmitter({ tenantId: identity.tenantId, turnId: job.turnId, ownerId: identity.ownerId });
	const generation = Number.parseInt(process.env[OWNER_START_GENERATION_VARIABLE] ?? "", 10);
	process.umask(0o002);
	const outcome = await observeOwnerRun(log, Number.isNaN(generation) ? {} : { generation }, async () => {
		const workerToken = await registerHostWorker({
			baseUrl: identity.frontDoorUrl,
			tenantId: identity.tenantId,
			workerId: identity.ownerId,
			invokeKey: identity.invokeKey,
		});
		const plane = new HostProtocolClient({
			baseUrl: identity.frontDoorUrl,
			tenantId: identity.tenantId,
			workerToken,
			userId: identity.userId,
			invokeKey: identity.invokeKey,
		});
		const deps = createContainerOwnerDeps(stores, log);
		return runOwnerOnComputerDisk(
			plane,
			{
				tenantId: identity.tenantId,
				workerId: identity.ownerId,
				turnId: job.turnId,
				...(Number.isNaN(generation) ? {} : { startGeneration: generation }),
				log,
				liveRoot: liveRootFromEnvironment(),
				store: snapshotStoreFromEnvironment(),
				afterHydrate: () => shareWorkspaceWithShell(workspaceRoot),
				onTerminate: (handler) => {
					process.once("SIGTERM", () => {
						void handler().finally(() => {
							log("owner_exit", { code: 143, outcome: "terminated" });
							process.exit(143);
						});
					});
				},
			},
			() => runOwnerEntryPoint({ claim: async () => job }, deps, { workspaceRoot, shellLauncherPath, fileHelperCommand, workerId: identity.ownerId }),
		);
	});
	console.info(`owner_outcome=${outcome} tenant_id=${job.tenantId} turn_id=${job.turnId}`);
	return ownerExitCodeFor(outcome);
}

if (import.meta.main) {
	process.exitCode = await ownerMain(process.argv.slice(2));
}
