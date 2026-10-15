import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HostDiskLifecycle } from "../../computer/host/src/host-disk-lifecycle.ts";
import { ProcessFileHelperLauncher } from "../../computer/host/src/live-file-helper-launcher.ts";
import { SealingOverlayApplier } from "../../computer/host/src/overlay-applier.ts";
import { OwnerSupervisor } from "../../computer/host/src/supervisor.ts";
import { supervisorConfigurationFromEnvironment, type SupervisorConfiguration } from "../../computer/host/src/supervisor-configuration.ts";
import type { StorageCredentialsProvider, SupervisorDisk } from "../../computer/host/src/supervisor-ports.ts";
import { ShellUserProcessSweeper } from "../../computer/host/src/unprivileged-process-sweeper.ts";
import { scrubbedShellEnvironment } from "../src/pi/shell-environment.ts";
import { SOURCE_FILE_HELPER_COMMAND } from "../src/pi/unprivileged-execution-env.ts";
import { formatLogLine, type LogFields } from "../src/observability/log-line.ts";
import { computerOwnerScenarioOf } from "./computer-owner.ts";
import { CountingSnapshotStore } from "./fakes/counting-snapshot-store.ts";
import { FakeChildSpawner } from "./fakes/fake-child-spawner.ts";
import { ScenarioFileHelperLauncher } from "./fakes/fake-file-helper-launcher.ts";
import { FakeOverlayBlobStore } from "./fakes/fake-overlay-blob-store.ts";
import { FakeProcessTable } from "./fakes/fake-process-table.ts";
import { FakeSupervisorClock } from "./fakes/fake-supervisor-clock.ts";
import { FakeSupervisorDisk } from "./fakes/fake-supervisor-disk.ts";
import { dispatchPollAnswer, FakeSupervisorPlane, FAKE_SUPERVISOR_SECRETS } from "./fakes/fake-supervisor-plane.ts";
import type { ChatticusWorld } from "./world.ts";

/** The secret values the scenario puts in the supervisor's task environment. */
export const TASK_ENVIRONMENT_SECRETS = {
	bootstrapToken: "scenario-bootstrap-token-value",
	invokeKey: "scenario-invoke-key-value",
	oldHostToken: "scenario-old-host-token-value",
	modelKey: "scenario-model-key-value",
} as const;

/** What one supervisor scenario holds between its steps. */
export type SupervisorScenario = {
	readonly environment: NodeJS.ProcessEnv;
	readonly clock: FakeSupervisorClock;
	readonly plane: FakeSupervisorPlane;
	readonly spawner: FakeChildSpawner;
	readonly table: FakeProcessTable;
	readonly logs: string[];
	readonly disk: FakeSupervisorDisk;
	/** The file helper the supervisor starts, and the directory that plays `/workspace` for its file requests. */
	readonly fileHelper: ScenarioFileHelperLauncher;
	workspaceRoot: string;
	/** The blobs of the scenario's edit overlay, read by the supervisor's overlay applier. */
	readonly overlayBlobs: FakeOverlayBlobStore;
	/** The snapshot store the real disk lifecycle hydrates from and publishes to. */
	readonly snapshotStore: CountingSnapshotStore;
	configuration: SupervisorConfiguration | null;
	useRealDisk: boolean;
	memoryUsedPercent: number | undefined;
	supervisor: OwnerSupervisor | null;
	exitCode: number | null;
	/** The fake time the supervisor started at and the fake time it ended at, when it has. */
	startedAtMilliseconds: number;
	exitedAtMilliseconds: number | null;
	/** How many times the supervisor opened the disk. */
	diskOpens: number;
	turnsStarted: number;
	childExitedAtMilliseconds: number;
	logIndexAtChildExit: number;
	stopRequestAtMilliseconds: number;
	/** Runs with the supervisor just before it starts running, so a scenario can attach what the production entry point attaches, such as the socket server. */
	beforeSupervisorRuns: ((supervisor: OwnerSupervisor) => Promise<void>) | null;
};

const scenarios = new WeakMap<ChatticusWorld, SupervisorScenario>();

/** The scenario's task environment as the starter would set it, secrets included. */
export function taskEnvironment(liveRoot: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: "/root",
		CHATTICUS_TENANT_ID: "anthus",
		CHATTICUS_USER_ID: "ryan",
		CHATTICUS_COMPUTER_ID: "household-computer",
		CHATTICUS_OWNER_ID: "owner-1",
		CHATTICUS_OWNER_START_GENERATION: "1",
		CHATTICUS_OWNER_BOOTSTRAP_TOKEN: TASK_ENVIRONMENT_SECRETS.bootstrapToken,
		CHATTICUS_FRONT_DOOR_URL: "https://front-door.example.test",
		CHATTICUS_MODEL_GATEWAY_URL: "https://front-door.example.test/orgs/anthus/model-gateway/v1",
		CHATTICUS_MESSAGING_TABLE: "messaging",
		CHATTICUS_CONVERSATIONS_TABLE: "conversations",
		CHATTICUS_PI_SESSIONS_BUCKET: "pi-sessions",
		CHATTICUS_SNAPSHOT_BUCKET: "snapshots",
		CHATTICUS_ENVIRONMENT: "development",
		CHATTICUS_LIVE_ROOT: liveRoot,
		CHATTICUS_WORKSPACE_ROOT: "/workspace",
		CHATTICUS_SHELL_LAUNCHER: "/usr/local/bin/chatticus-shell",
		AWS_REGION: "us-east-1",
		AWS_DEFAULT_REGION: "us-east-1",
		CHATTICUS_INVOKE_KEY: TASK_ENVIRONMENT_SECRETS.invokeKey,
		CHATTICUS_OWNER_HOST_TOKEN: TASK_ENVIRONMENT_SECRETS.oldHostToken,
		OPENAI_API_KEY: TASK_ENVIRONMENT_SECRETS.modelKey,
	};
}

/** Create the scenario's supervisor state: a fresh task environment, clock, control plane, spawner and process table. */
export function createSupervisorScenario(world: ChatticusWorld): SupervisorScenario {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const liveRoot = join(world.snapshotTmpdir, "supervisor-live");
	mkdirSync(join(liveRoot, "workspace"), { recursive: true });
	const clock = new FakeSupervisorClock();
	const logs: string[] = [];
	const workspaceRoot = computerOwnerScenarioOf(world).workspace;
	const processLauncher = new ProcessFileHelperLauncher({
		launcherPath: "/bin/sh",
		helperCommand: SOURCE_FILE_HELPER_COMMAND,
		workingDirectory: workspaceRoot,
		environment: scrubbedShellEnvironment(workspaceRoot),
	});
	const scenario: SupervisorScenario = {
		environment: taskEnvironment(liveRoot),
		clock,
		plane: new FakeSupervisorPlane(clock),
		spawner: new FakeChildSpawner(),
		table: new FakeProcessTable(),
		logs,
		disk: new FakeSupervisorDisk(clock, (event, fields) => logs.push(formatLogLine(event, { tenant_id: "anthus", owner_id: "owner-1", ...fields }))),
		fileHelper: new ScenarioFileHelperLauncher(clock, processLauncher),
		workspaceRoot,
		overlayBlobs: new FakeOverlayBlobStore(world.snapshotTmpdir),
		snapshotStore: new CountingSnapshotStore(join(world.snapshotTmpdir, "supervisor-store")),
		configuration: null,
		useRealDisk: false,
		memoryUsedPercent: undefined,
		supervisor: null,
		exitCode: null,
		startedAtMilliseconds: 0,
		exitedAtMilliseconds: null,
		diskOpens: 0,
		turnsStarted: 0,
		childExitedAtMilliseconds: -1,
		logIndexAtChildExit: 0,
		stopRequestAtMilliseconds: -1,
		beforeSupervisorRuns: null,
	};
	scenarios.set(world, scenario);
	return scenario;
}

/** The scenario's supervisor state; the Background creates it. */
export function supervisorScenarioOf(world: ChatticusWorld): SupervisorScenario {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "The scenario has no supervisor; its Background should create one.");
	return scenario;
}

/** Build the supervisor from the task environment, start it, and let it run until it waits for time. */
export async function startSupervisor(world: ChatticusWorld): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	const configuration = supervisorConfigurationFromEnvironment(scenario.environment);
	scenario.configuration = configuration;
	const emit = (event: string, fields: LogFields = {}): void => {
		scenario.logs.push(formatLogLine(event, { tenant_id: configuration.tenantId, owner_id: configuration.ownerId, ...fields }));
	};
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const openDisk = (credentials: StorageCredentialsProvider): SupervisorDisk => {
		scenario.diskOpens += 1;
		scenario.disk.attachCredentials(credentials);
		return scenario.useRealDisk
			? new HostDiskLifecycle(scenario.plane, {
					tenantId: configuration.tenantId,
					ownerId: configuration.ownerId,
					liveRoot: configuration.liveRoot,
					store: scenario.snapshotStore,
					log: emit,
					overlayApplier: new SealingOverlayApplier({
						ownerId: configuration.ownerId,
						generation: configuration.generation,
						plane: scenario.plane,
						launcher: scenario.fileHelper,
						workspaceRoot: scenario.workspaceRoot,
						blobs: scenario.overlayBlobs,
						clock: scenario.clock,
						log: emit,
					}),
				})
			: scenario.disk;
	};
	const supervisor = new OwnerSupervisor({
		identity: { tenantId: configuration.tenantId, ownerId: configuration.ownerId, generation: configuration.generation },
		environment: scenario.environment,
		plane: scenario.plane,
		openDisk,
		spawner: scenario.spawner,
		sweeper: new ShellUserProcessSweeper(scenario.table),
		clock: scenario.clock,
		log: emit,
		memoryUsedPercent: () => scenario.memoryUsedPercent,
		fileHelperLauncher: scenario.fileHelper,
		workspaceRoot: scenario.workspaceRoot,
	});
	scenario.supervisor = supervisor;
	scenario.startedAtMilliseconds = scenario.clock.nowMilliseconds();
	await scenario.beforeSupervisorRuns?.(supervisor);
	void supervisor.run().then((code) => {
		scenario.exitCode = code;
		scenario.exitedAtMilliseconds = scenario.clock.nowMilliseconds();
	});
	await scenario.clock.settle();
}

/** Start the supervisor and require that it reached idle without time passing. */
export async function startIdleSupervisor(world: ChatticusWorld): Promise<void> {
	await startSupervisor(world);
	const scenario = supervisorScenarioOf(world);
	assert.equal(scenario.exitCode, null, `The supervisor ended with code ${scenario.exitCode}. Log: ${scenario.logs.join(" | ")}`);
	assert.equal(scenario.supervisor?.state, "idle", `The supervisor is in state ${scenario.supervisor?.state}.`);
}

/** Let the supervisor's next poll offer one dispatch for the turn, and run until it has started its child. */
export async function offerDispatch(world: ChatticusWorld, turnId: string, options: { readonly botId?: string; readonly dispatchId?: string } = {}): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	scenario.plane.pollScript.push(dispatchPollAnswer({ turnId, ...options }, scenario.clock));
	await scenario.clock.advance(1000);
}

/** Serve one turn from an idle supervisor: offer the dispatch and require that the child started. */
export async function serveTurn(world: ChatticusWorld, turnId: string, options: { readonly dispatchId?: string } = {}): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	const before = scenario.spawner.children.length;
	await offerDispatch(world, turnId, options);
	assert.equal(scenario.spawner.children.length, before + 1, `No child started for turn ${turnId}. Log: ${scenario.logs.join(" | ")}`);
	scenario.turnsStarted += 1;
}

/** End the child that is running with the exit code, and let the supervisor react. */
export async function exitChild(world: ChatticusWorld, code: number): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	scenario.childExitedAtMilliseconds = scenario.clock.nowMilliseconds();
	scenario.logIndexAtChildExit = scenario.logs.length;
	scenario.spawner.lastChild.exitWithCode(code);
	await scenario.clock.settle();
}

/** Serve a fresh turn and end its child with the given code. */
export async function serveAndFinishTurn(world: ChatticusWorld, code: number): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	await serveTurn(world, `turn-${scenario.turnsStarted + 1}`);
	await exitChild(world, code);
}

/** The scenario's log lines that begin with the event name. */
export function logLinesOf(world: ChatticusWorld, event: string): string[] {
	return supervisorScenarioOf(world).logs.filter((line) => line === event || line.startsWith(`${event} `));
}

/** Every secret value the scenario handed out, for the log search. */
export function allScenarioSecrets(): string[] {
	return [...Object.values(TASK_ENVIRONMENT_SECRETS), ...Object.values(FAKE_SUPERVISOR_SECRETS)];
}

/** Every secret value the scenario handed out, the values the control plane issued in renewals included. */
export function allIssuedScenarioSecrets(world: ChatticusWorld): string[] {
	return [...allScenarioSecrets(), ...supervisorScenarioOf(world).plane.issuedSecrets];
}
