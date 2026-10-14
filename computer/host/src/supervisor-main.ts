import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { consoleLogEmitter } from "../../../conversation/src/observability/log-line.ts";
import { scrubbedShellEnvironment } from "../../../conversation/src/pi/shell-environment.ts";
import { S3SnapshotStore } from "../../../conversation/src/snapshot/s3.ts";
import { HostDiskLifecycle } from "./host-disk-lifecycle.ts";
import { ProcessFileHelperLauncher } from "./live-file-helper-launcher.ts";
import { SealingOverlayApplier } from "./overlay-applier.ts";
import { S3OverlayBlobReader } from "./overlay-blob-reader.ts";
import { OwnerConfigurationError } from "./owner-configuration.ts";
import { ProcessChildSpawner } from "./process-child-spawner.ts";
import { OwnerSupervisorClient } from "./protocol-client.ts";
import { OwnerSupervisor } from "./supervisor.ts";
import { supervisorConfigurationFromEnvironment } from "./supervisor-configuration.ts";
import { SupervisorSocketServer } from "./supervisor-socket.ts";
import { runtimeSupervisorClock, SUPERVISOR_EXIT_CONFIGURATION } from "./supervisor-ports.ts";
import { procProcessTable, ShellUserProcessSweeper } from "./unprivileged-process-sweeper.ts";
import { shareWorkspaceWithShell } from "./workspace-sharing.ts";

/** The directory the supervisor and its watchdog share. It belongs to root and no one else can enter it. */
export const SUPERVISOR_RUNTIME_DIRECTORY = "/run/chatticus";

/** The file the supervisor touches while its event loop turns; the watchdog kills a supervisor that lets it go stale. */
export const SUPERVISOR_LIVENESS_FILE = `${SUPERVISOR_RUNTIME_DIRECTORY}/supervisor.alive`;

/** Where the image installs the watchdog. */
export const WATCHDOG_PROGRAM_PATH = "/usr/local/bin/chatticus-watchdog";

const LIVENESS_TOUCH_INTERVAL_MILLISECONDS = 15_000;
const CONTROL_PLANE_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

function touchLivenessFile(): void {
	const now = new Date();
	try {
		writeFileSync(SUPERVISOR_LIVENESS_FILE, `${now.toISOString()}\n`, { mode: 0o600 });
	} catch {
		return;
	}
}

/**
 * The share of the container's memory in use, from the cgroup the container runs in.
 *
 * @returns A whole percent, or undefined when the cgroup files are unreadable or the container has no limit.
 */
export function containerMemoryUsedPercent(): number | undefined {
	try {
		const used = Number.parseInt(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim(), 10);
		const limit = Number.parseInt(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(), 10);
		if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return undefined;
		return Math.min(100, Math.round((used / limit) * 100));
	} catch {
		return undefined;
	}
}

/**
 * Entry point of the owner supervisor, the program the container runs. It reads its task environment (and removes the
 * bootstrap token from it), starts the watchdog as a separate process, and runs the supervisor until it stops itself.
 *
 * @param environment The process environment; the bootstrap token is deleted from it.
 * @returns The process exit code: 0 stopped in good order, 4 fenced, 5 no longer the owner, 6 bootstrap failed, 7 wrong settings, 8 the disk could not be restored, 9 still stopping when its credentials were about to end, 143 stopped by SIGTERM.
 */
export async function supervisorMain(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
	let configuration;
	try {
		configuration = supervisorConfigurationFromEnvironment(environment);
	} catch (error) {
		console.error(`owner_configuration_invalid ${error instanceof OwnerConfigurationError ? error.message : "unreadable settings"}`);
		return SUPERVISOR_EXIT_CONFIGURATION;
	}
	if (!existsSync(WATCHDOG_PROGRAM_PATH)) {
		console.error("owner_watchdog_unavailable");
		return SUPERVISOR_EXIT_CONFIGURATION;
	}
	mkdirSync(SUPERVISOR_RUNTIME_DIRECTORY, { recursive: true, mode: 0o700 });
	chmodSync(SUPERVISOR_RUNTIME_DIRECTORY, 0o700);
	touchLivenessFile();
	const liveness = setInterval(touchLivenessFile, LIVENESS_TOUCH_INTERVAL_MILLISECONDS);
	spawn(WATCHDOG_PROGRAM_PATH, [String(process.pid), SUPERVISOR_LIVENESS_FILE], {
		env: { PATH: environment["PATH"] ?? DEFAULT_PATH },
		detached: true,
		stdio: ["ignore", "inherit", "inherit"],
	}).unref();
	const log = consoleLogEmitter({ tenant_id: configuration.tenantId, owner_id: configuration.ownerId });
	const plane = new OwnerSupervisorClient({
		baseUrl: configuration.frontDoorUrl,
		tenantId: configuration.tenantId,
		userId: configuration.userId,
		bootstrapToken: configuration.bootstrapToken,
		requestTimeoutMilliseconds: CONTROL_PLANE_REQUEST_TIMEOUT_MILLISECONDS,
	});
	const fileHelperLauncher = new ProcessFileHelperLauncher({
		launcherPath: configuration.shellLauncherPath,
		helperCommand: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "file-helper.mjs")],
		workingDirectory: configuration.workspaceRoot,
		environment: scrubbedShellEnvironment(configuration.workspaceRoot, environment),
	});
	const supervisor = new OwnerSupervisor({
		identity: { tenantId: configuration.tenantId, ownerId: configuration.ownerId, generation: configuration.generation },
		environment,
		plane,
		openDisk: (credentials) => {
			const s3Client = new S3Client({ credentials });
			return new HostDiskLifecycle(plane, {
				tenantId: configuration.tenantId,
				ownerId: configuration.ownerId,
				liveRoot: configuration.liveRoot,
				store: new S3SnapshotStore(configuration.snapshotBucket, s3Client),
				log,
				afterHydrate: () => shareWorkspaceWithShell(configuration.workspaceRoot),
				overlayApplier: new SealingOverlayApplier({
					ownerId: configuration.ownerId,
					generation: configuration.generation,
					plane,
					launcher: fileHelperLauncher,
					workspaceRoot: configuration.workspaceRoot,
					blobs: new S3OverlayBlobReader(configuration.snapshotBucket, s3Client, async () => ({
						tenantId: configuration.tenantId,
						computerId: (await plane.getComputer()).computer_id,
					})),
					clock: runtimeSupervisorClock,
					log,
				}),
			});
		},
		spawner: new ProcessChildSpawner({
			command: process.execPath,
			bundlePath: join(dirname(fileURLToPath(import.meta.url)), "owner.mjs"),
			cwd: configuration.workspaceRoot,
		}),
		sweeper: new ShellUserProcessSweeper(procProcessTable()),
		clock: runtimeSupervisorClock,
		log,
		memoryUsedPercent: containerMemoryUsedPercent,
		fileHelperLauncher,
		workspaceRoot: configuration.workspaceRoot,
	});
	const socketServer = new SupervisorSocketServer({
		source: supervisor.turnCredentials,
		serving: () => supervisor.servingTurn,
		nowMilliseconds: () => runtimeSupervisorClock.nowMilliseconds(),
		log,
	});
	try {
		await socketServer.start();
	} catch (error) {
		clearInterval(liveness);
		console.error(`owner_socket_unavailable error_name=${error instanceof Error ? error.name : "unknown"}`);
		return SUPERVISOR_EXIT_CONFIGURATION;
	}
	process.once("SIGTERM", () => supervisor.requestTermination());
	try {
		return await supervisor.run();
	} finally {
		clearInterval(liveness);
		await socketServer.close();
	}
}

if (import.meta.main) {
	process.exit(await supervisorMain());
}
