import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	type OwnerEntryPointOutcome,
	type OwnerJobSource,
	runOwnerEntryPoint,
} from "../../../computer/host/src/owner.ts";
import { getTurn } from "../../src/domain/turns.ts";
import type { TurnExecutionJob } from "../../src/turn/types.ts";
import { activeTurnJob, computerOwnerDepsFor, computerOwnerScenarioOf } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { STORY_BOT, STORY_TENANT } from "../computer-scenario.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";

type EntryPointScenario = {
	job: TurnExecutionJob | null;
	shellLauncherPath: string | null;
	launcherLog: string | null;
	outcome: OwnerEntryPointOutcome | null;
	refusal: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, EntryPointScenario>();

function entryPointScenarioOf(world: ChatticusWorld): EntryPointScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { job: null, shellLauncherPath: null, launcherLog: null, outcome: null, refusal: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const temporaryDirectoryOf = (world: ChatticusWorld): string => {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	return world.snapshotTmpdir;
};

const passThroughLauncher = (world: ChatticusWorld): string => {
	const path = join(temporaryDirectoryOf(world), "pass-through-shell");
	writeFileSync(path, "#!/bin/sh\nexec /bin/bash \"$@\"\n");
	chmodSync(path, 0o755);
	return path;
};

async function runEntryPoint(world: ChatticusWorld): Promise<OwnerEntryPointOutcome> {
	const scenario = entryPointScenarioOf(world);
	const source: OwnerJobSource = {
		async claim() {
			const job = scenario.job;
			scenario.job = null;
			return job;
		},
	};
	return runOwnerEntryPoint(source, await computerOwnerDepsFor(world), {
		workspaceRoot: computerOwnerScenarioOf(world).workspace,
		shellLauncherPath: scenario.shellLauncherPath ?? passThroughLauncher(world),
	});
}

Given("an unprivileged shell launcher that records every command it starts", function (this: ChatticusWorld) {
	const scenario = entryPointScenarioOf(this);
	const log = join(temporaryDirectoryOf(this), "launcher.log");
	const path = join(temporaryDirectoryOf(this), "recording-shell");
	writeFileSync(path, `#!/bin/sh\necho started >> "${log}"\nexec /bin/bash "$@"\n`);
	chmodSync(path, 0o755);
	scenario.shellLauncherPath = path;
	scenario.launcherLog = log;
});

Given("the entry point is configured with a shell launcher that does not exist", function (this: ChatticusWorld) {
	entryPointScenarioOf(this).shellLauncherPath = join(temporaryDirectoryOf(this), "no-such-shell");
});

When("a takeover job names the turn", function (this: ChatticusWorld) {
	entryPointScenarioOf(this).job = activeTurnJob(this);
});

When("a takeover job names a turn that does not exist", function (this: ChatticusWorld) {
	const bot = this.botsByName?.get(STORY_BOT);
	entryPointScenarioOf(this).job = { tenantId: STORY_TENANT, turnId: "no-such-turn", botId: bot?.botId ?? "no-such-bot" };
});

When("no takeover job is waiting", function (this: ChatticusWorld) {
	entryPointScenarioOf(this).job = null;
});

When("the computer entry point runs", async function (this: ChatticusWorld) {
	entryPointScenarioOf(this).outcome = await runEntryPoint(this);
});

When("the computer entry point is run and refused", async function (this: ChatticusWorld) {
	const scenario = entryPointScenarioOf(this);
	try {
		scenario.outcome = await runEntryPoint(this);
	} catch (error) {
		scenario.refusal = error instanceof Error ? error.message : String(error);
		return;
	}
	assert.fail(`The entry point was not refused and ended ${scenario.outcome}.`);
});

Then("the entry point ended {string}", function (this: ChatticusWorld, outcome: string) {
	assert.equal(entryPointScenarioOf(this).outcome, outcome);
});

Then("the shell launcher started exactly {int} command(s)", function (this: ChatticusWorld, count: number) {
	const log = entryPointScenarioOf(this).launcherLog;
	assert.ok(log, "No recording shell launcher was configured.");
	const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
	assert.equal(lines.length, count, JSON.stringify(lines));
});

Then("the refusal mentions {string}", function (this: ChatticusWorld, text: string) {
	const refusal = entryPointScenarioOf(this).refusal;
	assert.ok(refusal?.includes(text), String(refusal));
});

Then("the turn is still active with no attempt taken", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const turn = await getTurn(this.turnDependencies(), tenantId, turnId);
	assert.equal(turn.status, "active");
	assert.equal(turn.attempt, 0);
	assert.equal(modelScenarioOf(this).scripted.callCount, 0);
});
