import { createContainerOwnerDeps, ownerStoresConfigFromEnvironment } from "./owner-deps.ts";
import {
	DEFAULT_SHELL_LAUNCHER_PATH,
	DEFAULT_WORKSPACE_ROOT,
	runOwnerEntryPoint,
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
 * with `owner_no_job` and success; a named turn ends with `owner_outcome=<outcome>`.
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
	process.umask(0o002);
	await shareWorkspaceWithShell(workspaceRoot);
	const deps = createContainerOwnerDeps(stores);
	const outcome = await runOwnerEntryPoint({ claim: async () => job }, deps, { workspaceRoot, shellLauncherPath });
	console.info(`owner_outcome=${outcome} tenant_id=${job.tenantId} turn_id=${job.turnId}`);
	return outcome === "done" || outcome === "parked" || outcome === "yielded" ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await ownerMain(process.argv.slice(2));
}
