import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { ChatticusWorld } from "../world.ts";

const WATCHDOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "computer", "chatticus-watchdog");
const CHECK_SECONDS = "0.1";
const WATCHDOG_STARTUP_MILLISECONDS = 300;

type WatchedSupervisor = {
	readonly supervisor: ChildProcess;
	readonly watchdog: ChildProcess;
	readonly clockFile: string;
	readonly livenessFile: string;
	readonly terminateMarkerFile: string;
	readonly startedAtSeconds: number;
	watchdogOutput: string;
	supervisorEnded: { code: number | null; signal: string | null } | null;
	watchdogEnded: { code: number | null; signal: string | null } | null;
};

const watched = new WeakMap<ChatticusWorld, WatchedSupervisor>();

const pause = (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds));

function watchedOf(world: ChatticusWorld): WatchedSupervisor {
	const scenario = watched.get(world);
	assert.ok(scenario, "No watchdog was started in this scenario.");
	return scenario;
}

async function until(condition: () => boolean, milliseconds: number): Promise<boolean> {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await pause(20);
	}
	return condition();
}

function startWatchdog(world: ChatticusWorld, livenessAgeSeconds: number): void {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const directory = world.snapshotTmpdir;
	const startedAtSeconds = Math.floor(Date.now() / 1000);
	const clockFile = join(directory, "watchdog-clock");
	const livenessFile = join(directory, "supervisor.alive");
	const terminateMarkerFile = join(directory, "terminate-marker");
	writeFileSync(clockFile, String(startedAtSeconds));
	writeFileSync(livenessFile, "");
	utimesSync(livenessFile, startedAtSeconds - livenessAgeSeconds, startedAtSeconds - livenessAgeSeconds);
	writeFileSync(terminateMarkerFile, "");
	const supervisor = spawn("sh", ["-c", "trap 'echo term >> \"$0\"' TERM; while :; do sleep 0.05; done", terminateMarkerFile], { stdio: "ignore" });
	const watchdog = spawn(WATCHDOG_PATH, [String(supervisor.pid), livenessFile], {
		env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CHATTICUS_WATCHDOG_CLOCK_FILE: clockFile, CHATTICUS_WATCHDOG_CHECK_SECONDS: CHECK_SECONDS },
		stdio: ["ignore", "pipe", "ignore"],
	});
	const scenario: WatchedSupervisor = {
		supervisor,
		watchdog,
		clockFile,
		livenessFile,
		terminateMarkerFile,
		startedAtSeconds,
		watchdogOutput: "",
		supervisorEnded: null,
		watchdogEnded: null,
	};
	watchdog.stdout?.on("data", (chunk: Buffer) => {
		scenario.watchdogOutput += chunk.toString("utf8");
	});
	supervisor.once("exit", (code, signal) => {
		scenario.supervisorEnded = { code, signal };
	});
	watchdog.once("exit", (code, signal) => {
		scenario.watchdogEnded = { code, signal };
	});
	watched.set(world, scenario);
}

function moveClockTo(scenario: WatchedSupervisor, secondsAfterStart: number): void {
	const now = scenario.startedAtSeconds + secondsAfterStart;
	writeFileSync(scenario.clockFile, String(now));
	utimesSync(scenario.livenessFile, now, now);
}

After(function (this: ChatticusWorld) {
	const scenario = watched.get(this);
	if (scenario === undefined) return;
	scenario.supervisor.kill("SIGKILL");
	scenario.watchdog.kill("SIGKILL");
	watched.delete(this);
});

Given("a watchdog watching a supervisor whose liveness file is {int} seconds old", async function (this: ChatticusWorld, seconds: number) {
	startWatchdog(this, seconds);
	await pause(WATCHDOG_STARTUP_MILLISECONDS);
});

Given("a watchdog watching a supervisor that is still running", async function (this: ChatticusWorld) {
	startWatchdog(this, 0);
	await pause(WATCHDOG_STARTUP_MILLISECONDS);
});

When("the watchdog checks", async function (this: ChatticusWorld) {
	const scenario = watchedOf(this);
	await until(() => scenario.supervisorEnded !== null, 1500);
});

When("{int} seconds have passed", async function (this: ChatticusWorld, seconds: number) {
	const scenario = watchedOf(this);
	moveClockTo(scenario, seconds);
	await until(() => scenario.supervisorEnded !== null || readFileSync(scenario.terminateMarkerFile, "utf8").includes("term"), 1500);
	await pause(500);
});

Then("it kills the supervisor with SIGKILL and logs {string} with action {string} and reason {string}", function (this: ChatticusWorld, event: string, action: string, reason: string) {
	const scenario = watchedOf(this);
	assert.equal(scenario.supervisorEnded?.signal, "SIGKILL");
	assert.ok(scenario.watchdogOutput.includes(`${event} action=${action} reason=${reason}`), scenario.watchdogOutput);
});

Then("the watched supervisor is still running", function (this: ChatticusWorld) {
	assert.equal(watchedOf(this).supervisorEnded, null);
});

Then("the watchdog logged nothing", function (this: ChatticusWorld) {
	assert.equal(watchedOf(this).watchdogOutput, "");
});

Then("it sends SIGTERM once", function (this: ChatticusWorld) {
	const scenario = watchedOf(this);
	assert.ok(existsSync(scenario.terminateMarkerFile));
	const terminations = readFileSync(scenario.terminateMarkerFile, "utf8").split("\n").filter((line) => line === "term");
	assert.equal(terminations.length, 1);
	assert.equal(scenario.supervisorEnded, null);
	assert.equal(scenario.watchdogOutput.match(/action=term reason=deadline/g)?.length, 1, scenario.watchdogOutput);
});

Then("it sends SIGKILL", function (this: ChatticusWorld) {
	const scenario = watchedOf(this);
	assert.equal(scenario.supervisorEnded?.signal, "SIGKILL");
	assert.ok(scenario.watchdogOutput.includes("action=kill reason=deadline"), scenario.watchdogOutput);
});

Then("it exits when the supervisor is gone", async function (this: ChatticusWorld) {
	const scenario = watchedOf(this);
	assert.ok(await until(() => scenario.watchdogEnded !== null, 2000), "The watchdog kept running.");
	assert.equal(scenario.watchdogEnded?.code, 0);
});
