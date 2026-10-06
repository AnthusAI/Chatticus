import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BROWSE_ACTION_KIND } from "@chatticus/host-protocol";
import { Given, Then, When } from "@cucumber/cucumber";
import { browserProfileDir } from "../../../computer/host/src/browser-profiles.ts";
import { ChromiumActionExecutor, type ProcessRunner } from "../../../computer/host/src/executors/chromium.ts";
import type { HostActionRunner } from "../../../computer/host/src/main.ts";
import { ValueError } from "../../../computer/host/src/workspace-paths.ts";
import { actionStoreOf } from "../computer-support.ts";
import {
	STORY_BOT,
	STORY_TENANT,
	STORY_USER,
	computerScenarioOf,
	deliverStartJob,
	journalNow,
	queuedStartJobs,
	startStoryTurn,
	workTurn,
} from "../computer-scenario.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { bootDriverFor, ensureHostWorker, hostDiskOf, lifecycleOf, loopHostStartDriver, runHostUntilIdle } from "../host-lifecycle-support.ts";
import { activeTurnOf, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";

const BROWSER_HOST_WORKER_ID = "computer-host";
const FIRST_RACING_HOST_ID = "racing-host-a";
const SECOND_RACING_HOST_ID = "racing-host-b";
const DISPLAY = ":99";
const FAKE_CHROMIUM_BINARY = "/usr/bin/chromium";
const OPENED_RESULT = "opened";
const BROWSER_ORIGIN = "https://household.example.com";
const UNTRUSTED_PAGE = "https://untrusted.example/article";
const BANKING_PARTITION = "privileged:banking";

/** An executor that counts how often the host asked it to run an action, and answers as a browser would. */
class CountingHostExecutor implements HostActionRunner {
	calls = 0;

	async execute(): Promise<string> {
		this.calls += 1;
		return OPENED_RESULT;
	}
}

type ChromiumScenario = {
	executorError: Error | null;
	liveRoot: string | null;
	commands: string[][];
	counting: CountingHostExecutor | null;
};

const scenarios = new WeakMap<ChatticusWorld, ChromiumScenario>();

function chromiumOf(world: ChatticusWorld): ChromiumScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { executorError: null, liveRoot: null, commands: [], counting: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function recordingRunner(scenario: ChromiumScenario): ProcessRunner {
	return async (command) => {
		scenario.commands.push([...command]);
		return { returnCode: 0, standardOutput: "<html></html>", standardError: "" };
	};
}

function startJobOf(world: ChatticusWorld) {
	const job = computerScenarioOf(world).startJob;
	assert.ok(job, "The scenario has no queued continuation job.");
	return job;
}

Given("the computer host has booted through the browser gate", async function (this: ChatticusWorld) {
	await ensureHostWorker(this, STORY_TENANT, BROWSER_HOST_WORKER_ID);
	const driver = bootDriverFor(this, BROWSER_HOST_WORKER_ID, null);
	await driver.bootThroughBrowser();
	lifecycleOf(this).lastBootedHost = BROWSER_HOST_WORKER_ID;
	assert.deepEqual(driver.lastBoot?.readinessOrder, ["model", "workspace", "browser"]);
});

When(
	"a computer-capable pull worker with a chromium executor pulls that continuation job",
	async function (this: ChatticusWorld) {
		const scenario = chromiumOf(this);
		const executor = new ChromiumActionExecutor({
			display: DISPLAY,
			liveRoot: hostDiskOf(this, BROWSER_HOST_WORKER_ID).liveRoot,
			runner: recordingRunner(scenario),
			binaryPath: () => FAKE_CHROMIUM_BINARY,
		});
		executor.execute = async () => OPENED_RESULT;
		const driver = loopHostStartDriver(() => runHostUntilIdle(this, BROWSER_HOST_WORKER_ID, executor));
		await deliverStartJob(this, startJobOf(this), driver);
		assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
		assert.equal((await runQueuedJobs(this)).at(-1), "done");
	},
);

When("a chromium executor runs an unsupported browser tool", async function (this: ChatticusWorld) {
	const scenario = chromiumOf(this);
	scenario.executorError = null;
	try {
		await new ChromiumActionExecutor({ display: DISPLAY }).execute("browser_click", { selector: "button" });
	} catch (error) {
		scenario.executorError = error as Error;
	}
});

Then("the chromium executor reports the tool is unsupported", function (this: ChatticusWorld) {
	const error = chromiumOf(this).executorError;
	assert.ok(error instanceof ValueError, "The chromium executor ran the tool.");
	assert.ok(error.message.includes("does not support"), error.message);
});

Given("a browser-waiting turn with a queued continuation job", async function (this: ChatticusWorld) {
	modelScenarioOf(this).scripted.toolCall("browse", { url: `${BROWSER_ORIGIN}/inbox` }, "I will open the household browser.").reply("The browser is open.");
	await startStoryTurn(this, "open the household browser");
	const headers = await memberHeadersFor(this, STORY_TENANT, STORY_USER);
	const granted = await putActiveTurnGrant(
		this,
		headers,
		{ tools: ["browse"], origins: [BROWSER_ORIGIN], recipients: [], file_scopes: [], egress_classes: ["approved_origin_fetch"], ingest_classes: [] },
		STORY_TENANT,
	);
	assert.equal(granted.status, 200, granted.text);
	assert.equal(await workTurn(this, STORY_BOT), "parked");
	const state = computerScenarioOf(this);
	const [job] = queuedStartJobs(this);
	assert.ok(job, "The browser-waiting turn queued no continuation job.");
	state.startJob = job;
	const { tenantId, turnId } = activeTurnOf(this);
	const [action] = await actionStoreOf(this).listForTurn(tenantId, turnId);
	state.pendingActionId = action!.actionId;
});

Given("one computer continuation job is delivered twice", function (this: ChatticusWorld) {
	chromiumOf(this).counting = new CountingHostExecutor();
});

When(
	"two computer-capable pull workers with a host executor pull that continuation concurrently",
	async function (this: ChatticusWorld) {
		const counting = chromiumOf(this).counting;
		assert.ok(counting, "The scenario has no counting host executor.");
		for (const workerId of [FIRST_RACING_HOST_ID, SECOND_RACING_HOST_ID]) {
			await ensureHostWorker(this, STORY_TENANT, workerId);
		}
		const driver = loopHostStartDriver(() =>
			Promise.all([FIRST_RACING_HOST_ID, SECOND_RACING_HOST_ID].map((workerId) => runHostUntilIdle(this, workerId, counting))),
		);
		const job = startJobOf(this);
		await Promise.all([deliverStartJob(this, job, driver), deliverStartJob(this, job, driver)]);
		assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
		assert.equal((await runQueuedJobs(this)).at(-1), "done");
	},
);

Then("the turn journal records exactly one tool.result for the pending action id", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const { tenantId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, state.pendingActionId!);
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result" && event.action_id === action?.callId);
	assert.equal(results.length, 1);
	assert.equal(results[0]!.body, OPENED_RESULT);
});

Then("the host executor ran the pending action once", function (this: ChatticusWorld) {
	assert.equal(chromiumOf(this).counting?.calls, 1);
});

Given("the household computer holds privileged cookies only under the banking browser profile", function (this: ChatticusWorld) {
	assert.ok(this.snapshotTmpdir, "The scenario has no scratch directory.");
	const liveRoot = join(this.snapshotTmpdir, "computer-live");
	mkdirSync(liveRoot, { recursive: true });
	chromiumOf(this).liveRoot = liveRoot;
	const cookies = join(browserProfileDir(liveRoot, BANKING_PARTITION), "Default", "Cookies");
	mkdirSync(dirname(cookies), { recursive: true });
	writeFileSync(cookies, "signed-in\n");
});

When("a chromium executor opens an untrusted browser page", async function (this: ChatticusWorld) {
	const scenario = chromiumOf(this);
	assert.ok(scenario.liveRoot, "The scenario has no live root.");
	const executor = new ChromiumActionExecutor({
		display: DISPLAY,
		liveRoot: scenario.liveRoot,
		runner: recordingRunner(scenario),
		binaryPath: () => FAKE_CHROMIUM_BINARY,
	});
	await executor.execute(BROWSE_ACTION_KIND, { url: UNTRUSTED_PAGE, storage_partition: "untrusted" });
});

function userDataArgument(world: ChatticusWorld): string {
	const command = chromiumOf(world).commands.at(-1);
	assert.ok(command, "The chromium executor launched no browser.");
	const argument = command.find((candidate) => candidate.startsWith("--user-data-dir="));
	assert.ok(argument, "The browser was launched with no user data directory.");
	return argument;
}

Then("the chromium executor used the untrusted browser profile directory", function (this: ChatticusWorld) {
	assert.equal(userDataArgument(this), `--user-data-dir=${browserProfileDir(chromiumOf(this).liveRoot!, "untrusted")}`);
});

Then("the chromium executor did not use the privileged banking browser profile directory", function (this: ChatticusWorld) {
	assert.ok(!userDataArgument(this).includes(browserProfileDir(chromiumOf(this).liveRoot!, BANKING_PARTITION)));
});

When("a computer-capable pull worker with a chromium executor runs the browse action", async function (this: ChatticusWorld) {
	const scenario = chromiumOf(this);
	const executor = new ChromiumActionExecutor({
		display: DISPLAY,
		liveRoot: hostDiskOf(this, BROWSER_HOST_WORKER_ID).liveRoot,
		runner: recordingRunner(scenario),
		binaryPath: () => FAKE_CHROMIUM_BINARY,
	});
	const driver = loopHostStartDriver(() => runHostUntilIdle(this, BROWSER_HOST_WORKER_ID, executor));
	await deliverStartJob(this, startJobOf(this), driver);
	assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
	assert.equal((await runQueuedJobs(this)).at(-1), "done");
});

Then("the turn journal records the opened page for the browse action", async function (this: ChatticusWorld) {
	const { tenantId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, computerScenarioOf(this).pendingActionId!);
	assert.equal(action?.toolName, BROWSE_ACTION_KIND);
	const events = await journalNow(this);
	const results = events.filter((event) => event.kind === "tool.result" && event.action_id === action?.callId);
	assert.equal(results.length, 1);
	assert.equal(results[0]!.body, `opened:${BROWSER_ORIGIN}/inbox`);
	assert.equal(events.at(-1)!.kind, "turn.completed");
});

Then("the chromium executor launched the browser on that page", function (this: ChatticusWorld) {
	const command = chromiumOf(this).commands.at(-1);
	assert.ok(command, "The chromium executor launched no browser.");
	assert.equal(command.at(-1), `${BROWSER_ORIGIN}/inbox`);
});
