import { createContainerOwnerDeps, ownerIdentityFromEnvironment, ownerStoresConfigFromEnvironment } from "./owner-deps.ts";
import { snapshotStoreFromEnvironment } from "./disk-lifecycle.ts";
import { HostProtocolClient, registerHostWorker } from "./protocol-client.ts";
import { liveRootFromEnvironment } from "./live-root.ts";
import {
	DEFAULT_SHELL_LAUNCHER_PATH,
	DEFAULT_WORKSPACE_ROOT,
	ownerExitCodeFor,
	runOwnerEntryPoint,
	runOwnerOnComputerDisk,
	runShellProbe,
	shareWorkspaceWithShell,
	startJobSourceFromEnvironment,
} from "./owner.ts";

const workspaceRoot = (process.env["CHATTICUS_WORKSPACE_ROOT"] ?? "").trim() || DEFAULT_WORKSPACE_ROOT;
const shellLauncherPath = (process.env["CHATTICUS_SHELL_LAUNCHER"] ?? "").trim() || DEFAULT_SHELL_LAUNCHER_PATH;

/**
 * Entry point of the container owner program.
 *
 * `shell-probe <command>` runs one command through the shell launcher and prints what it left, so an image can show what
 * the unprivileged shell reaches. With no argument the program takes over the turn the start named: no named turn ends
 * with `owner_no_job` and success. For a named turn the owner registers with the Front Door under its owner id, hydrates
 * the computer's snapshot into the workspace, runs the turn under that owner id, publishes the disk when it is dirty and
 * marks the computer stopped, then ends with `owner_outcome=<outcome>`; the exit code is 0 when the turn reached a
 * terminal state or was parked or yielded for another owner.
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
	const source = startJobSourceFromEnvironment();
	const job = await source.claim();
	if (job === null) {
		console.info("owner_no_job");
		return 0;
	}
	const stores = ownerStoresConfigFromEnvironment();
	const identity = ownerIdentityFromEnvironment();
	process.umask(0o002);
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
	const deps = createContainerOwnerDeps(stores);
	const outcome = await runOwnerOnComputerDisk(
		plane,
		{
			tenantId: identity.tenantId,
			workerId: identity.ownerId,
			liveRoot: liveRootFromEnvironment(),
			store: snapshotStoreFromEnvironment(),
			afterHydrate: () => shareWorkspaceWithShell(workspaceRoot),
			onTerminate: (handler) => {
				process.once("SIGTERM", () => {
					void handler().finally(() => process.exit(143));
				});
			},
		},
		() => runOwnerEntryPoint({ claim: async () => job }, deps, { workspaceRoot, shellLauncherPath, workerId: identity.ownerId }),
	);
	console.info(`owner_outcome=${outcome} tenant_id=${job.tenantId} turn_id=${job.turnId}`);
	return ownerExitCodeFor(outcome);
}

if (import.meta.main) {
	process.exitCode = await ownerMain(process.argv.slice(2));
}
