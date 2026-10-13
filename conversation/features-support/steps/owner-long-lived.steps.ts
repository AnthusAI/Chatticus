import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS, type OwnerPollResponse } from "@chatticus/host-protocol/supervisor";
import { ownerExitCodeFor, ownerChildExitCodeForError } from "../../../computer/host/src/owner.ts";
import { OwnerSupervisorClient } from "../../../computer/host/src/protocol-client.ts";
import { OwnerSupervisor } from "../../../computer/host/src/supervisor.ts";
import { supervisorConfigurationFromEnvironment } from "../../../computer/host/src/supervisor-configuration.ts";
import type { ChildSpawner, OwnerChildSubcommand, SpawnedChild, ChildExit } from "../../../computer/host/src/supervisor-ports.ts";
import { ShellUserProcessSweeper } from "../../../computer/host/src/unprivileged-process-sweeper.ts";
import { ensureComputer } from "../../src/domain/computers.ts";
import { getTurn } from "../../src/domain/turns.ts";
import { registerWorker } from "../../src/domain/workers.ts";
import { mintOwnerBootstrapToken } from "../../src/gateway/session-token.ts";
import { formatLogLine } from "../../src/observability/log-line.ts";
import type { TurnTakeoverOutcome } from "../../src/turn/computer-owner.ts";
import { actionStoreOf } from "../computer-support.ts";
import { memberFilesOf } from "../computer-file-live-support.ts";
import { computerOwnerScenarioOf, startComputerOwner, type HeldOwner } from "../computer-owner.ts";
import { computerScenarioOf, deliverStartJob, STORY_BOT, STORY_TENANT, STORY_USER, workTurn } from "../computer-scenario.ts";
import type { FileHelperLauncher } from "../../../computer/host/src/live-file-helper-launcher.ts";
import type { SupervisorDisk } from "../../../computer/host/src/supervisor-ports.ts";
import { UNUSED_FILE_HELPER_LAUNCHER } from "../fakes/fake-file-helper-launcher.ts";
import { FakeHostStartDriver } from "../fakes/fake-host-start-driver.ts";
import { FakeProcessTable } from "../fakes/fake-process-table.ts";
import { FakeSupervisorDisk } from "../fakes/fake-supervisor-disk.ts";
import { WorldSupervisorClock } from "../fakes/world-supervisor-clock.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import { taskEnvironment } from "../owner-supervisor-support.ts";
import { ensureMember } from "../turn-grant-support.ts";
import { queuedRunsFor } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";
import { ownerServerOf } from "./owner-supervisor-server.steps.ts";

const FRONT_DOOR_ORIGIN = "http://front-door.test";
const REAL_PAUSE_MILLISECONDS = 10;
const QUIET_CHECKS_REQUIRED = 3;
const MAXIMUM_WAKES = 400;
const MAXIMUM_REAL_WAITS_FOR_A_SLEEPER = 300;

type ChildPhase = "starting" | "held" | "running" | "done";

type ServedChild = {
	readonly turnId: string;
	phase: ChildPhase;
	held: HeldOwner | null;
	handle: ControlledChild;
};

/** What one scenario's supervisor keeps between its steps. */
export type LongLivedScenario = {
	readonly clock: WorldSupervisorClock;
	readonly logs: string[];
	readonly children: ServedChild[];
	readonly outcomesByTurn: Map<string, TurnTakeoverOutcome>;
	readonly stopReasons: string[];
	readonly supervisor: OwnerSupervisor;
	exitCode: number | null;
	inFlightRequests: number;
	activity: number;
	holdNextChild: boolean;
	exitedChildren: number;
	pollCount: number;
};

const scenarios = new WeakMap<ChatticusWorld, LongLivedScenario>();

/** The running long-lived supervisor scenario of this world. */
export function longLivedOf(world: ChatticusWorld): LongLivedScenario {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "No supervisor is running in this scenario.");
	return scenario;
}

class ControlledChild implements SpawnedChild {
	readonly pid: number;
	readonly exited: Promise<ChildExit>;
	private finishWith: (exit: ChildExit) => void = () => undefined;

	constructor(pid: number) {
		this.pid = pid;
		this.exited = new Promise<ChildExit>((resolve) => {
			this.finishWith = resolve;
		});
	}

	kill(signal: "SIGTERM" | "SIGKILL"): void {
		this.finishWith({ code: null, signal });
	}

	finish(exit: ChildExit): void {
		this.finishWith(exit);
	}
}

/** Starts, in this process, a computer owner for the turn of each dispatch, the way the supervisor starts a child process for it. */
class TakeoverChildSpawner implements ChildSpawner {
	private readonly world: ChatticusWorld;
	private readonly scenario: () => LongLivedScenario;
	private nextPid = 5000;

	constructor(world: ChatticusWorld, scenario: () => LongLivedScenario) {
		this.world = world;
		this.scenario = scenario;
	}

	spawn(_subcommand: OwnerChildSubcommand, environment: Record<string, string>): SpawnedChild {
		const scenario = this.scenario();
		const handle = new ControlledChild(this.nextPid++);
		const turnId = environment["CHATTICUS_TAKEOVER_TURN_ID"]!;
		const botId = environment["CHATTICUS_TAKEOVER_BOT_ID"]!;
		const ownerId = environment["CHATTICUS_OWNER_ID"]!;
		const served: ServedChild = { turnId, phase: "starting", held: null, handle };
		const hold = scenario.holdNextChild;
		scenario.holdNextChild = false;
		scenario.children.push(served);
		scenario.activity += 1;
		void (async () => {
			try {
				const { ended, held } = await startComputerOwner(this.world, `served-${scenario.children.length}`, {
					hold,
					job: { tenantId: STORY_TENANT, turnId, botId },
					workerId: ownerId,
				});
				served.held = held;
				if (held !== null) {
					await Promise.race([held.reached, ended]);
					if (served.phase === "starting") served.phase = "held";
				} else served.phase = "running";
				scenario.activity += 1;
				const outcome = await ended;
				scenario.outcomesByTurn.set(turnId, outcome);
				served.phase = "done";
				scenario.exitedChildren += 1;
				scenario.activity += 1;
				handle.finish({ code: ownerExitCodeFor(outcome), signal: null });
			} catch (error) {
				served.phase = "done";
				scenario.exitedChildren += 1;
				scenario.activity += 1;
				handle.finish({ code: ownerChildExitCodeForError(error), signal: null });
			}
		})();
		return handle;
	}
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, REAL_PAUSE_MILLISECONDS));

/** Wait, in real time, until nothing the supervisor started is still working. */
export async function settle(scenario: LongLivedScenario): Promise<void> {
	let quiet = 0;
	let lastActivity = scenario.activity;
	while (quiet < QUIET_CHECKS_REQUIRED) {
		await pause();
		const working = scenario.children.some((child) => child.phase === "starting" || child.phase === "running");
		if (scenario.inFlightRequests === 0 && !working && scenario.activity === lastActivity) quiet += 1;
		else {
			quiet = 0;
			lastActivity = scenario.activity;
		}
	}
}

async function whileCounted<Value>(scenario: LongLivedScenario, work: () => Promise<Value>): Promise<Value> {
	scenario.inFlightRequests += 1;
	scenario.activity += 1;
	try {
		return await work();
	} finally {
		scenario.inFlightRequests -= 1;
		scenario.activity += 1;
	}
}

/** The disk, with every call counted as work in flight, so that a step does not move time while a restore or a publish runs. */
function trackedDisk(scenario: () => LongLivedScenario, disk: SupervisorDisk): SupervisorDisk {
	return {
		hydrate: () => whileCounted(scenario(), () => disk.hydrate()),
		clearApplied: (entries) => whileCounted(scenario(), () => disk.clearApplied(entries)),
		needsPublish: () => whileCounted(scenario(), () => disk.needsPublish()),
		publish: () => whileCounted(scenario(), () => disk.publish()),
	};
}

/** The file helper launcher, with every run counted as work in flight. */
function trackedLauncher(scenario: () => LongLivedScenario, launcher: FileHelperLauncher): FileHelperLauncher {
	return { run: (request, timeoutMilliseconds) => whileCounted(scenario(), () => launcher.run(request, timeoutMilliseconds)) };
}

/**
 * Let the supervisor go on until the condition holds: the scenario's fake time moves to the supervisor's next sleeper each
 * time the supervisor has nothing left to do in real time.
 */
export async function runUntil(world: ChatticusWorld, description: string, done: () => boolean | Promise<boolean>): Promise<void> {
	const scenario = longLivedOf(world);
	for (let wakes = 0; wakes < MAXIMUM_WAKES; wakes += 1) {
		await settle(scenario);
		if (await done()) return;
		for (let waits = 0; waits < MAXIMUM_REAL_WAITS_FOR_A_SLEEPER && !scenario.clock.hasSleepers() && scenario.exitCode === null; waits += 1) {
			await pause();
			await settle(scenario);
			if (await done()) return;
		}
		assert.ok(scenario.clock.hasSleepers() && scenario.exitCode === null, `The supervisor cannot go on before: ${description}. Log: ${scenario.logs.join(" | ")}`);
		scenario.clock.wakeNext();
	}
	assert.fail(`The supervisor did not reach: ${description}. Log: ${scenario.logs.join(" | ")}`);
}

/** The lines of the supervisor's log for one event. */
export const logLinesOf = (scenario: LongLivedScenario, event: string): string[] => scenario.logs.filter((line) => line === event || line.startsWith(`${event} `));

const routedFetch =
	(world: ChatticusWorld, scenario: () => LongLivedScenario): typeof fetch =>
	async (input, init) => {
		assert.ok(world.app, "The scenario has no HTTP front door.");
		const path = new URL(String(input)).pathname;
		const state = scenario();
		state.inFlightRequests += 1;
		state.activity += 1;
		try {
			const response = await world.app.request(path, init);
			if (path.endsWith("/owner/poll") && response.status === 200) {
				const answer = (await response.clone().json()) as OwnerPollResponse;
				const recorded = ownerServerOf(world);
				recorded.polls.push(answer);
				recorded.dispatches.push(...answer.dispatches);
				state.pollCount += 1;
			}
			if ((path.endsWith("/owner/poll") || path.endsWith("/owner/file-results")) && response.status === 200) memberFilesOf(world).wait.release();
			if (path.endsWith("/owner/stop-request")) {
				const body = JSON.parse(String(init?.body)) as { reason: string };
				state.stopReasons.push(body.reason);
			}
			return response;
		} finally {
			state.inFlightRequests -= 1;
			state.activity += 1;
		}
	};

Given("a supervisor is running for the household computer", async function (this: ChatticusWorld) {
	assert.ok(this.snapshotTmpdir, "The scenario has no temporary directory.");
	const liveRoot = join(this.snapshotTmpdir, "long-lived-live");
	mkdirSync(join(liveRoot, "workspace"), { recursive: true });
	await startLongLivedSupervisor(this, {
		liveRoot,
		workspaceRoot: computerOwnerScenarioOf(this).workspace,
		fileHelperLauncher: UNUSED_FILE_HELPER_LAUNCHER,
		openDisk: ({ clock, log }) => new FakeSupervisorDisk(clock, log),
	});
});

/** What differs between the supervisors the long-lived scenarios start: the disk, the file helper and where they work. */
export type LongLivedWiring = {
	/** The directory the task's `CHATTICUS_LIVE_ROOT` names. */
	readonly liveRoot: string;
	/** Where the supervisor runs file requests. */
	readonly workspaceRoot: string;
	readonly fileHelperLauncher: FileHelperLauncher;
	readonly openDisk: (context: {
		readonly ownerId: string;
		readonly generation: number;
		readonly plane: OwnerSupervisorClient;
		readonly clock: WorldSupervisorClock;
		readonly log: (event: string, fields?: Record<string, string | number | boolean | null | undefined>) => void;
	}) => SupervisorDisk;
};

/**
 * Bring up the organization's computer the way the starter does and run a supervisor on it over the scenario's production
 * routes, until its first poll. The scenario's fake time moves only when a step wakes the supervisor's next sleeper.
 */
export async function startLongLivedSupervisor(world: ChatticusWorld, wiring: LongLivedWiring): Promise<void> {
	await ensureMember(world, STORY_TENANT, STORY_USER);
	const state = computerScenarioOf(world);
	state.driver ??= new FakeHostStartDriver();
	const computer = await ensureComputer(STORY_TENANT, { store: world.messagingStore(), ids: world.ids });
	const job = {
		jobId: world.ids.next(),
		tenantId: STORY_TENANT,
		turnId: "owner-bring-up",
		botId: "bring-up",
		userId: STORY_USER,
		computerId: computer.computerId,
		computerPolicy: "prefer_local" as const,
		requiredCapabilities: ["computer"],
	};
	world.queues.send("computer-starts", job);
	await deliverStartJob(world, job, state.driver);
	assert.equal(state.startError, null, state.startError?.message);
	assert.equal(state.startOutcome?.kind, "started");
	const driver = state.driver as FakeHostStartDriver;
	const claim = driver.invocations.at(-1)?.claim;
	assert.ok(claim, "The starter did not call the host start driver.");

	const ownerId = `owner-${world.ids.next()}`;
	await registerWorker(
		{ workerId: ownerId, tenantId: STORY_TENANT, costClass: "local", capabilities: ["cpu", "computer"], computerId: claim.computerId },
		{ store: world.messagingStore(), clock: world.clock, ids: world.ids },
	);
	const issuedAtSeconds = Math.floor(world.clock.now().getTime() / 1000);
	const bootstrapToken = mintOwnerBootstrapToken(SCENARIO_GATEWAY_SIGNING_KEY, {
		audience: "owner-bootstrap",
		tenantId: STORY_TENANT,
		computerId: claim.computerId,
		ownerId,
		startGeneration: claim.hostStartGeneration,
		issuedAtSeconds,
		expiresAtSeconds: issuedAtSeconds + OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS,
	});
	const recorded = ownerServerOf(world);
	recorded.ownerId = ownerId;
	recorded.computerId = claim.computerId;
	recorded.generation = claim.hostStartGeneration;
	recorded.bootstrapToken = bootstrapToken;

	const environment = {
		...taskEnvironment(wiring.liveRoot),
		CHATTICUS_TENANT_ID: STORY_TENANT,
		CHATTICUS_USER_ID: STORY_USER,
		CHATTICUS_COMPUTER_ID: claim.computerId,
		CHATTICUS_OWNER_ID: ownerId,
		CHATTICUS_OWNER_START_GENERATION: String(claim.hostStartGeneration),
		CHATTICUS_OWNER_BOOTSTRAP_TOKEN: bootstrapToken,
		CHATTICUS_FRONT_DOOR_URL: FRONT_DOOR_ORIGIN,
		CHATTICUS_MODEL_GATEWAY_URL: `${FRONT_DOOR_ORIGIN}/orgs/${STORY_TENANT}/model-gateway/v1`,
	};
	const configuration = supervisorConfigurationFromEnvironment(environment);
	const clock = new WorldSupervisorClock(world.clock);
	const logs: string[] = [];
	const emit = (event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void => {
		logs.push(formatLogLine(event, { tenant_id: STORY_TENANT, owner_id: ownerId, ...fields }));
	};
	let scenario!: LongLivedScenario;
	const plane = new OwnerSupervisorClient({
		baseUrl: FRONT_DOOR_ORIGIN,
		tenantId: STORY_TENANT,
		userId: STORY_USER,
		bootstrapToken: configuration.bootstrapToken,
		fetchFunction: routedFetch(world, () => scenario),
	});
	computerOwnerScenarioOf(world);
	const supervisor = new OwnerSupervisor({
		identity: { tenantId: configuration.tenantId, ownerId: configuration.ownerId, generation: configuration.generation },
		environment,
		plane,
		openDisk: () => trackedDisk(() => scenario, wiring.openDisk({ ownerId, generation: configuration.generation, plane, clock, log: emit })),
		spawner: new TakeoverChildSpawner(world, () => scenario),
		sweeper: new ShellUserProcessSweeper(new FakeProcessTable()),
		clock,
		log: emit,
		fileHelperLauncher: trackedLauncher(() => scenario, wiring.fileHelperLauncher),
		workspaceRoot: wiring.workspaceRoot,
	});
	scenario = {
		clock,
		logs,
		children: [],
		outcomesByTurn: new Map(),
		stopReasons: [],
		supervisor,
		exitCode: null,
		inFlightRequests: 0,
		activity: 0,
		holdNextChild: false,
		exitedChildren: 0,
		pollCount: 0,
	};
	scenarios.set(world, scenario);
	void supervisor.run().then((code) => {
		scenario.exitCode = code;
		scenario.activity += 1;
	});
	await runUntil(world, "its first poll", () => scenario.pollCount >= 1);
	assert.equal(scenario.exitCode, null, `The supervisor ended with code ${scenario.exitCode}. Log: ${logs.join(" | ")}`);
}

Given("the owner was bootstrapped {int} seconds ago", async function (this: ChatticusWorld, seconds: number) {
	const store = this.messagingStore();
	const computer = await store.getComputer(STORY_TENANT);
	assert.ok(computer?.ownerStartedAt, "The computer records no owner start.");
	await store.putComputer({ ...computer, ownerStartedAt: new Date(this.clock.now().getTime() - seconds * 1000) });
});

async function pollOnce(world: ChatticusWorld): Promise<void> {
	const scenario = longLivedOf(world);
	const before = scenario.pollCount;
	await runUntil(world, "its next poll", () => scenario.pollCount > before);
}

async function served(world: ChatticusWorld): Promise<void> {
	const scenario = longLivedOf(world);
	const turnId = world.lastTurnId;
	assert.ok(turnId, "No turn was asked for.");
	await runUntil(world, `the turn ${turnId} is served`, async () => {
		const turn = await getTurn(world.turnDependencies(), STORY_TENANT, turnId);
		return scenario.outcomesByTurn.has(turnId) && scenario.supervisor.state === "idle" && turn.waitingFor === null;
	});
}

When("the supervisor polls until it is served", async function (this: ChatticusWorld) {
	await served(this);
});

When("the supervisor polls", async function (this: ChatticusWorld) {
	await pollOnce(this);
});

async function holdChildAfterItsTool(world: ChatticusWorld): Promise<ServedChild> {
	const scenario = longLivedOf(world);
	const before = scenario.children.length;
	scenario.holdNextChild = true;
	await runUntil(world, "a child held after its tool ran", () => scenario.children.length > before && scenario.children[before]!.phase === "held");
	return scenario.children[before]!;
}

When("the supervisor polls and its child is held mid-turn", async function (this: ChatticusWorld) {
	await holdChildAfterItsTool(this);
});

When("the supervisor polls and its child is killed after its tool ran", async function (this: ChatticusWorld) {
	const child = await holdChildAfterItsTool(this);
	child.handle.kill("SIGKILL");
	await settle(longLivedOf(this));
});

When("the held child is released and the supervisor polls until it is served", async function (this: ChatticusWorld) {
	const scenario = longLivedOf(this);
	const held = scenario.children.find((child) => child.phase === "held")?.held;
	assert.ok(held, "No child is held.");
	held.release();
	await held.ended;
	await served(this);
});

When("the supervisor stops with reason {string}", async function (this: ChatticusWorld, reason: string) {
	const scenario = longLivedOf(this);
	await runUntil(this, "the supervisor has ended", () => scenario.exitCode !== null);
	assert.equal(scenario.exitCode, 0, `Log: ${scenario.logs.join(" | ")}`);
	assert.equal(scenario.stopReasons.at(-1), reason);
});

Then("the turn ended {string}", function (this: ChatticusWorld, outcome: string) {
	assert.ok(this.lastTurnId, "No turn was asked for.");
	const servedBySupervisor = longLivedOf(this).outcomesByTurn.get(this.lastTurnId);
	assert.equal(servedBySupervisor ?? computerScenarioOf(this).lastOutcome, outcome);
});

Then("the turn of bot {string} ended {string}", async function (this: ChatticusWorld, botName: string, outcome: string) {
	const bot = this.botsByName?.get(botName);
	assert.ok(bot, `Bot ${botName} not found`);
	for (const [turnId, ended] of longLivedOf(this).outcomesByTurn) {
		const turn = await getTurn(this.turnDependencies(), STORY_TENANT, turnId);
		if (turn.botId === bot.botId) {
			assert.equal(ended, outcome);
			return;
		}
	}
	assert.fail(`No child served a turn of bot ${botName}.`);
});

Then("the turn of bot {string} is still waiting for the computer", async function (this: ChatticusWorld, botName: string) {
	const bot = this.botsByName?.get(botName);
	assert.ok(bot, `Bot ${botName} not found`);
	const turnId = this.lastTurnId;
	assert.ok(turnId, "No turn was asked for.");
	const turn = await getTurn(this.turnDependencies(), STORY_TENANT, turnId);
	assert.equal(turn.botId, bot.botId);
	assert.notEqual(turn.waitingFor, null);
	assert.equal(turn.status, "active");
});

Then("the log has one {string} line and two {string} lines", function (this: ChatticusWorld, once: string, twice: string) {
	const scenario = longLivedOf(this);
	assert.equal(logLinesOf(scenario, once).length, 1);
	assert.equal(logLinesOf(scenario, twice).length, 2);
});

Then("the supervisor logged {string} with clean {string}", function (this: ChatticusWorld, event: string, clean: string) {
	const lines = logLinesOf(longLivedOf(this), event);
	assert.ok(lines.some((line) => line.includes(`clean=${clean}`)), `No ${event} line with clean=${clean}: ${lines.join(" | ")}`);
});

Then("the supervisor is still polling", async function (this: ChatticusWorld) {
	const scenario = longLivedOf(this);
	assert.equal(scenario.exitCode, null);
	await pollOnce(this);
	assert.equal(scenario.supervisor.state, "idle");
});

Then("a run job is queued for the turn", function (this: ChatticusWorld) {
	assert.ok(this.lastTurnId, "No turn was asked for.");
	assert.equal(queuedRunsFor(this, this.lastTurnId).length, 1);
});

When("a Lambda-style owner works the turn until it ends", async function (this: ChatticusWorld) {
	assert.equal(await workTurn(this, STORY_BOT), "done");
});

Then("the tool {string} was reported lost and not run again", async function (this: ChatticusWorld, tool: string) {
	assert.equal(tool, "run_terminal");
	assert.ok(this.lastTurnId, "No turn was asked for.");
	const actions = await actionStoreOf(this).listForTurn(STORY_TENANT, this.lastTurnId);
	assert.equal(actions.length, 1, JSON.stringify(actions));
	assert.equal(actions[0]!.status, "done");
	assert.equal(actions[0]!.resultIsError, true);
	assert.ok(String(actions[0]!.result).includes("was lost while this tool ran"), String(actions[0]!.result));
	const lines = readFileSync(join(computerOwnerScenarioOf(this).workspace, "runs.log"), "utf8").split("\n").filter((line) => line !== "");
	assert.equal(lines.length, 1);
});
