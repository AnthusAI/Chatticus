import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	OWNER_CHILD_ENVIRONMENT_NAMES,
	type OwnerErrorCode,
	type OwnerPollResponse,
	type OwnerStopReason,
	type OwnerStopVetoReason,
} from "@chatticus/host-protocol/supervisor";
import { dispatchPollAnswer, FAKE_SUPERVISOR_SECRETS, ownerRouteRefusal } from "../fakes/fake-supervisor-plane.ts";
import {
	allScenarioSecrets,
	createSupervisorScenario,
	exitChild,
	logLinesOf,
	offerDispatch,
	serveAndFinishTurn,
	serveTurn,
	startIdleSupervisor,
	startSupervisor,
	supervisorScenarioOf,
	TASK_ENVIRONMENT_SECRETS,
} from "../owner-supervisor-support.ts";
import type { ChatticusWorld } from "../world.ts";

const lastPoll = (world: ChatticusWorld) => {
	const polls = supervisorScenarioOf(world).plane.polls;
	const poll = polls.at(-1);
	assert.ok(poll, "The supervisor has not polled.");
	return poll;
};

const requireExit = (world: ChatticusWorld, code: number): void => {
	const scenario = supervisorScenarioOf(world);
	assert.equal(scenario.exitCode, code, `Expected exit code ${code}, saw ${scenario.exitCode}. Log: ${scenario.logs.join(" | ")}`);
};

const stopRequestsOf = (world: ChatticusWorld, reason: OwnerStopReason) =>
	supervisorScenarioOf(world).plane.stopRequests.filter((recorded) => recorded.request.reason === reason);

Given("a supervisor whose task environment holds a bootstrap token", function (this: ChatticusWorld) {
	createSupervisorScenario(this);
});

Given("the supervisor restores its disk through the real disk lifecycle", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).useRealDisk = true;
});

Given("the control plane holds the report that the computer is running", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).plane.holdRunningReport();
});

Given("the control plane answers the bootstrap with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.bootstrapScript = [ownerRouteRefusal(status, code as OwnerErrorCode)];
});

Given("the control plane answers the bootstrap with {int} {string} twice and then succeeds", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.bootstrapScript = [ownerRouteRefusal(status, code as OwnerErrorCode), ownerRouteRefusal(status, code as OwnerErrorCode)];
});

Given("the control plane answers every bootstrap with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.bootstrapRepeat = ownerRouteRefusal(status, code as OwnerErrorCode);
});

Given("the disk cannot be restored", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).disk.restoreFails = true;
});

Given("an idle supervisor", async function (this: ChatticusWorld) {
	await startIdleSupervisor(this);
});

Given("a supervisor serving turn {string} under dispatch {string}", async function (this: ChatticusWorld, turnId: string, dispatchId: string) {
	await startIdleSupervisor(this);
	await serveTurn(this, turnId, { dispatchId });
});

Given("a supervisor serving turn {string}", async function (this: ChatticusWorld, turnId: string) {
	await startIdleSupervisor(this);
	await serveTurn(this, turnId);
});

Given("a supervisor serving turn {string} with a changed workspace", async function (this: ChatticusWorld, turnId: string) {
	await startIdleSupervisor(this);
	await serveTurn(this, turnId);
	supervisorScenarioOf(this).disk.workspaceChanged = true;
});

Given("a supervisor serving turn {string} whose child ignores signals until killed", async function (this: ChatticusWorld, turnId: string) {
	await startIdleSupervisor(this);
	supervisorScenarioOf(this).spawner.ignoreTerminateFromNowOn = true;
	await serveTurn(this, turnId);
});

Given("a supervisor serving turn {string} while an unprivileged process {string} runs", async function (this: ChatticusWorld, turnId: string, name: string) {
	await startIdleSupervisor(this);
	await serveTurn(this, turnId);
	supervisorScenarioOf(this).table.add(name, 2000);
});

Given("an idle supervisor that changed the workspace in its last turn", async function (this: ChatticusWorld) {
	await startIdleSupervisor(this);
	await serveTurn(this, "turn-1");
	supervisorScenarioOf(this).disk.workspaceChanged = true;
	await exitChild(this, 0);
});

Given("the workspace has changed", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).disk.workspaceChanged = true;
});

Given("the control plane vetoes a stop with {string}", function (this: ChatticusWorld, reason: string) {
	supervisorScenarioOf(this).plane.stopScript = [{ approved: false, reason: reason as OwnerStopVetoReason }];
});

Given("the control plane vetoes a stop with {string} and offers a dispatch on the next poll", function (this: ChatticusWorld, reason: string) {
	const scenario = supervisorScenarioOf(this);
	scenario.plane.stopScript = [{ approved: false, reason: reason as OwnerStopVetoReason }];
	scenario.plane.pollAfterNextStopRequest = dispatchPollAnswer({ turnId: "turn-late" }, scenario.clock);
});

Given("the control plane vetoes every idle stop with {string}", function (this: ChatticusWorld, reason: string) {
	supervisorScenarioOf(this).plane.vetoesByReason.set("idle", reason as OwnerStopVetoReason);
});

Given("every poll fails", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).plane.failEveryPoll = new TypeError("fetch failed");
});

Given("the container uses {int} percent of its memory", function (this: ChatticusWorld, percent: number) {
	supervisorScenarioOf(this).memoryUsedPercent = percent;
});

Given("the next snapshot publish fails", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).disk.publishFailuresToCome = 1;
});

Given("the control plane refuses the stopped report twice", function (this: ChatticusWorld) {
	const failure = new TypeError("fetch failed");
	supervisorScenarioOf(this).plane.stoppedReportScript = [failure, failure];
});

Given("the control plane answers the stopped report with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.stoppedReportScript = [ownerRouteRefusal(status, code as OwnerErrorCode)];
});

Given("a supervisor that has served one turn and stopped for being idle", async function (this: ChatticusWorld) {
	await startIdleSupervisor(this);
	await serveAndFinishTurn(this, 0);
	await supervisorScenarioOf(this).clock.advance(900_000);
	await supervisorScenarioOf(this).clock.advance(10_000);
	requireExit(this, 0);
});

When("the supervisor starts", async function (this: ChatticusWorld) {
	await startSupervisor(this);
});

When("{int} seconds go by", async function (this: ChatticusWorld, seconds: number) {
	await supervisorScenarioOf(this).clock.advance(seconds * 1000);
});

When("{int} more seconds go by", async function (this: ChatticusWorld, seconds: number) {
	await supervisorScenarioOf(this).clock.advance(seconds * 1000);
});

When("{int} seconds go by without a dispatch", async function (this: ChatticusWorld, seconds: number) {
	await supervisorScenarioOf(this).clock.advance(seconds * 1000);
});

When("{int} seconds go by after the child exited", async function (this: ChatticusWorld, seconds: number) {
	await supervisorScenarioOf(this).clock.advance(seconds * 1000);
});

When("{int} seconds go by with no change to the workspace", async function (this: ChatticusWorld, seconds: number) {
	await supervisorScenarioOf(this).clock.advance(seconds * 1000);
});

When("the control plane releases the held report", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	scenario.plane.releaseHeldReport();
	await scenario.clock.settle();
});

When("the control plane offers a dispatch for turn {string} of bot {string}", async function (this: ChatticusWorld, turnId: string, botId: string) {
	await offerDispatch(this, turnId, { botId });
});

When("the control plane offers dispatch {string} for turn {string}", async function (this: ChatticusWorld, dispatchId: string, turnId: string) {
	await offerDispatch(this, turnId, { dispatchId });
});

When("the child exits with code {int}", async function (this: ChatticusWorld, code: number) {
	await exitChild(this, code);
});

When("three children in a row exit with code {int}", async function (this: ChatticusWorld, code: number) {
	for (let count = 0; count < 3; count += 1) await serveAndFinishTurn(this, code);
});

When("two children in a row exit with code {int}", async function (this: ChatticusWorld, code: number) {
	for (let count = 0; count < 2; count += 1) await serveAndFinishTurn(this, code);
});

When("a child exits with code {int}", async function (this: ChatticusWorld, code: number) {
	await serveAndFinishTurn(this, code);
});

When("the workspace changes again", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).disk.workspaceChanged = true;
});

When("the control plane answers a poll with drain and reason {string}", async function (this: ChatticusWorld, reason: string) {
	const scenario = supervisorScenarioOf(this);
	const answer: OwnerPollResponse = { dispatches: [], file_requests: [], drain: true, drain_reason: reason, next_poll_ms: 1000 };
	scenario.plane.pollScript.push(answer);
	await scenario.clock.advance(1000);
});

When("the control plane answers a poll with {int} {string}", async function (this: ChatticusWorld, status: number, code: string) {
	const scenario = supervisorScenarioOf(this);
	scenario.plane.pollScript.push(ownerRouteRefusal(status, code as OwnerErrorCode));
	await scenario.clock.advance(1000);
});

When("a poll with sequence {int} times out", async function (this: ChatticusWorld, sequence: number) {
	const scenario = supervisorScenarioOf(this);
	scenario.plane.sequenceToTimeOut = sequence;
	await scenario.clock.advance(sequence * 1000);
});

When("the supervisor receives SIGTERM", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.supervisor);
	scenario.supervisor.requestTermination();
	await scenario.clock.settle();
});

Then("it exchanged the bootstrap token once and removed it from its environment", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.plane.bootstraps.length, 1);
	assert.equal(scenario.plane.bootstraps[0]?.request.owner_id, "owner-1");
	assert.equal(scenario.plane.bootstraps[0]?.request.generation, 1);
	assert.equal(scenario.environment["CHATTICUS_OWNER_BOOTSTRAP_TOKEN"], undefined);
	assert.equal(scenario.configuration?.bootstrapToken, TASK_ENVIRONMENT_SECRETS.bootstrapToken);
});

Then("its polls so far went through the states {string}", function (this: ChatticusWorld, states: string) {
	const seen: string[] = [];
	for (const recorded of supervisorScenarioOf(this).plane.polls) {
		if (seen.at(-1) !== recorded.request.state) seen.push(recorded.request.state);
	}
	assert.equal(seen.join(", "), states);
});

Then("it reported the computer running and the model and workspace gates ready", function (this: ChatticusWorld) {
	const calls = supervisorScenarioOf(this).plane.computerCalls;
	const order = ["stopped:false", "ready:model", "ready:workspace"].map((call) => calls.indexOf(call));
	assert.ok(order.every((index) => index >= 0), calls.join(", "));
	assert.deepEqual(order, [...order].sort((first, second) => first - second));
});

Then("its latest poll was in state {string}", function (this: ChatticusWorld, state: string) {
	assert.equal(lastPoll(this).request.state, state);
});

Then("the supervisor's environment holds no AWS access key, secret key or session token", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
		assert.equal(scenario.environment[name], undefined, `${name} is set in the supervisor's environment`);
		assert.equal(process.env[name], undefined, `${name} is set in the process environment`);
	}
	const processValues = Object.values(process.env);
	for (const secret of [FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId, FAKE_SUPERVISOR_SECRETS.supervisorSecretAccessKey, FAKE_SUPERVISOR_SECRETS.supervisorSessionToken]) {
		assert.ok(!processValues.includes(secret), "The supervisor's credentials are in the process environment");
	}
});

Then("it exits with code {int} and logs {string}", function (this: ChatticusWorld, code: number, event: string) {
	requireExit(this, code);
	assert.ok(logLinesOf(this, event).length > 0, `No ${event} line. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then("it exits with code {int} and logs {string} with reason {string}", function (this: ChatticusWorld, code: number, event: string, reason: string) {
	requireExit(this, code);
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`reason=${reason}`)), `No ${event} line with reason ${reason}.`);
});

Then("it started no child and published nothing", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.spawner.children.length, 0);
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 0);
	assert.ok(!scenario.plane.computerCalls.includes("published"));
});

Then("it reported no stop", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.plane.stopRequests.length, 0);
	assert.equal(scenario.plane.stoppedReports.length, 0);
});

Then("the control plane saw {int} bootstrap attempts", function (this: ChatticusWorld, count: number) {
	assert.equal(supervisorScenarioOf(this).plane.bootstraps.length, count);
});

Then("the supervisor is still running", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).exitCode, null, `The supervisor ended with ${supervisorScenarioOf(this).exitCode}.`);
});

Then("the supervisor starts one child with the subcommand {string}", function (this: ChatticusWorld, subcommand: string) {
	assert.equal(supervisorScenarioOf(this).spawner.children.length, 1);
	assert.equal(supervisorScenarioOf(this).spawner.lastChild.subcommand, subcommand);
	assert.equal(supervisorScenarioOf(this).spawner.lastChild.environment["CHATTICUS_TAKEOVER_TURN_ID"], "turn-1");
});

Then("the supervisor starts one child", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).spawner.children.length, 1);
});

Then("the child's environment holds exactly the names in the child list", function (this: ChatticusWorld) {
	const names = Object.keys(supervisorScenarioOf(this).spawner.lastChild.environment).sort();
	assert.deepEqual(names, [...OWNER_CHILD_ENVIRONMENT_NAMES].sort());
});

Then("the child's environment holds the dispatch's gateway token and the dispatch's AWS credentials", function (this: ChatticusWorld) {
	const environment = supervisorScenarioOf(this).spawner.lastChild.environment;
	assert.equal(environment["CHATTICUS_MODEL_GATEWAY_TOKEN"], FAKE_SUPERVISOR_SECRETS.gatewayToken);
	assert.equal(environment["AWS_ACCESS_KEY_ID"], FAKE_SUPERVISOR_SECRETS.turnAccessKeyId);
	assert.equal(environment["AWS_SECRET_ACCESS_KEY"], FAKE_SUPERVISOR_SECRETS.turnSecretAccessKey);
	assert.equal(environment["AWS_SESSION_TOKEN"], FAKE_SUPERVISOR_SECRETS.turnSessionToken);
	assert.equal(environment["CHATTICUS_TAKEOVER_BOT_ID"], "bot-1");
	assert.equal(environment["CHATTICUS_USER_ID"], "ryan");
});

Then(
	"the child's environment holds none of the bootstrap token, the supervisor token, the Front Door address, the snapshot bucket, the live root, the invoke key, the old host token or a model key",
	function (this: ChatticusWorld) {
		const scenario = supervisorScenarioOf(this);
		const values = Object.values(scenario.spawner.lastChild.environment);
		const forbidden = [
			TASK_ENVIRONMENT_SECRETS.bootstrapToken,
			FAKE_SUPERVISOR_SECRETS.supervisorToken,
			FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId,
			FAKE_SUPERVISOR_SECRETS.supervisorSecretAccessKey,
			FAKE_SUPERVISOR_SECRETS.supervisorSessionToken,
			"https://front-door.example.test",
			"snapshots",
			scenario.configuration?.liveRoot ?? "no-live-root",
			TASK_ENVIRONMENT_SECRETS.invokeKey,
			TASK_ENVIRONMENT_SECRETS.oldHostToken,
			TASK_ENVIRONMENT_SECRETS.modelKey,
		];
		for (const secret of forbidden) assert.ok(!values.includes(secret), `The child holds ${secret.slice(0, 8)}...`);
	},
);

Then("the supervisor's next poll is in state {string} with the turn and the dispatch id", function (this: ChatticusWorld, state: string) {
	const request = lastPoll(this).request;
	assert.equal(request.state, state);
	assert.deepEqual(request.active_turns, [{ turn_id: "turn-1", dispatch_id: "dispatch-turn-1" }]);
});

Then("it logged {string} and {string}", function (this: ChatticusWorld, first: string, second: string) {
	assert.ok(logLinesOf(this, first).length > 0, `No ${first} line.`);
	assert.ok(logLinesOf(this, second).length > 0, `No ${second} line.`);
});

Then("it logged {string}", function (this: ChatticusWorld, event: string) {
	assert.ok(logLinesOf(this, event).length > 0, `No ${event} line. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then("the supervisor starts no second child", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).spawner.children.length, 1);
});

Then("the supervisor kills every process of the unprivileged user", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.table.listings > 0, "The supervisor never looked at the process table.");
});

Then("it logs {string} with clean {string}", function (this: ChatticusWorld, event: string, clean: string) {
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`clean=${clean}`)), `No ${event} line with clean=${clean}.`);
});

Then("it polls immediately in state {string}", function (this: ChatticusWorld, state: string) {
	const scenario = supervisorScenarioOf(this);
	const poll = lastPoll(this);
	assert.equal(poll.request.state, state);
	assert.equal(poll.atMilliseconds, scenario.childExitedAtMilliseconds);
});

Then("its idle clock restarts", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const restarted = scenario.logs.slice(scenario.logIndexAtChildExit).some((line) => line.startsWith("owner_idle ") && line.includes("idle_seconds=0"));
	assert.ok(restarted, "The supervisor did not log a new idle clock after the child exited.");
});

Then("the supervisor counts no failure", function (this: ChatticusWorld) {
	const exited = logLinesOf(this, "owner_child_exited");
	assert.ok(exited.length > 0);
	assert.ok(exited.every((line) => line.includes("consecutive_failures=0")), exited.join(" | "));
});

Then("the supervisor asks to stop with reason {string}", function (this: ChatticusWorld, reason: string) {
	assert.ok(stopRequestsOf(this, reason as OwnerStopReason).length > 0, `No stop request with reason ${reason}.`);
});

Then("the supervisor asks to stop with reason {string} once", function (this: ChatticusWorld, reason: string) {
	assert.equal(stopRequestsOf(this, reason as OwnerStopReason).length, 1);
});

Then("the supervisor asks to stop with reason {string} with no active turn", function (this: ChatticusWorld, reason: string) {
	const requests = stopRequestsOf(this, reason as OwnerStopReason);
	assert.ok(requests.length > 0, `No stop request with reason ${reason}.`);
	assert.deepEqual(requests.at(-1)?.request.active_turns, []);
});

Then("it asks to stop with reason {string} with no active turn", function (this: ChatticusWorld, reason: string) {
	const requests = stopRequestsOf(this, reason as OwnerStopReason);
	assert.ok(requests.length > 0, `No stop request with reason ${reason}.`);
	assert.deepEqual(requests.at(-1)?.request.active_turns, []);
});

Then("after the approval it reports the computer stopped and exits with code {int}", function (this: ChatticusWorld, code: number) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.plane.stoppedReports.length, 1);
	assert.equal(scenario.plane.stoppedReports[0]?.generation, 1);
	requireExit(this, code);
});

Then("after the approval it publishes if changed, reports the computer stopped and exits with code {int}", function (this: ChatticusWorld, code: number) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.plane.stoppedReports.length, 1);
	assert.equal(scenario.disk.workspaceChanged, false);
	requireExit(this, code);
});

Then("the supervisor has not asked to stop", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).plane.stopRequests.length, 0);
});

Then("process {string} is killed", function (this: ChatticusWorld, name: string) {
	assert.ok(supervisorScenarioOf(this).table.killed.some((entry) => entry.name === name && entry.uid === 2000), `${name} was not killed.`);
	assert.ok(!supervisorScenarioOf(this).table.hasRunning(name));
});

Then("no process of the root user is killed", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.table.killed.length > 0);
	assert.ok(scenario.table.killed.every((entry) => entry.uid !== 0), JSON.stringify(scenario.table.killed));
	assert.ok(scenario.table.hasRunning("supervisor"));
});

Then("after the approval it reports state {string}", function (this: ChatticusWorld, state: string) {
	const scenario = supervisorScenarioOf(this);
	const stopAt = scenario.plane.stopRequests.at(0)?.atMilliseconds;
	assert.ok(stopAt !== undefined, "The supervisor never asked to stop.");
	assert.ok(
		scenario.plane.polls.some((poll) => poll.atMilliseconds >= stopAt && poll.request.state === state),
		`No poll after the stop request was in state ${state}.`,
	);
});

Then("it publishes the snapshot", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const stopAt = scenario.plane.stopRequests.at(0)?.atMilliseconds ?? scenario.plane.stoppedReports.at(0)?.atMilliseconds ?? 0;
	assert.ok(scenario.disk.publishedAtMilliseconds.some((publishedAt) => publishedAt >= stopAt), "No publish happened at the stop.");
});

Then("it reports the computer stopped for its generation", function (this: ChatticusWorld) {
	const reports = supervisorScenarioOf(this).plane.stoppedReports;
	assert.equal(reports.length, 1);
	assert.equal(reports[0]?.generation, 1);
});

Then("it exits with code {int}", function (this: ChatticusWorld, code: number) {
	requireExit(this, code);
});

Then("the log has {string} with reason {string} and {string}", function (this: ChatticusWorld, event: string, reason: string, other: string) {
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`reason=${reason}`)), `No ${event} line with reason ${reason}.`);
	assert.ok(logLinesOf(this, other).length > 0, `No ${other} line.`);
});

Then("the log has {string} with reason {string}", function (this: ChatticusWorld, event: string, reason: string) {
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`reason=${reason}`)), `No ${event} line with reason ${reason}.`);
});

Then("it logs {string} with reason {string}", function (this: ChatticusWorld, event: string, reason: string) {
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`reason=${reason}`)), `No ${event} line with reason ${reason}. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then("it has not asked again", function (this: ChatticusWorld) {
	assert.equal(stopRequestsOf(this, "idle").length, 1);
});

Then("it asks again", function (this: ChatticusWorld) {
	assert.equal(stopRequestsOf(this, "idle").length, 2);
});

Then("the supervisor reports state {string} and accepts no dispatch", async function (this: ChatticusWorld, state: string) {
	const scenario = supervisorScenarioOf(this);
	await scenario.clock.advance(1000);
	assert.equal(lastPoll(this).request.state, state);
	const before = scenario.spawner.children.length;
	scenario.plane.pollScript.push(dispatchPollAnswer({ turnId: "turn-refused" }, scenario.clock));
	await scenario.clock.advance(1000);
	assert.equal(scenario.spawner.children.length, before);
});

Then("the supervisor sends the child SIGTERM", function (this: ChatticusWorld) {
	assert.deepEqual(supervisorScenarioOf(this).spawner.lastChild.signalsReceived.slice(0, 1), ["SIGTERM"]);
});

Then("it sends the child SIGKILL", function (this: ChatticusWorld) {
	assert.deepEqual(supervisorScenarioOf(this).spawner.lastChild.signalsReceived, ["SIGTERM", "SIGKILL"]);
});

Then("the supervisor polls in state {string} and publishes the snapshot", function (this: ChatticusWorld, state: string) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(lastPoll(this).request.state, state);
	assert.equal(scenario.disk.workspaceChanged, true, "The disk was published before the poll reported publishing.");
});

Then("it logs {string} with reason {string} and reports no state change", function (this: ChatticusWorld, event: string, reason: string) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`reason=${reason}`)), `No ${event} line with reason ${reason}.`);
	const published = scenario.disk.publishedAtMilliseconds.at(-1) ?? 0;
	assert.ok(
		scenario.plane.polls.filter((poll) => poll.atMilliseconds > published + 1000).every((poll) => poll.request.state === "idle"),
		"A poll after the quiet publish reported a state other than idle.",
	);
});

Then("the supervisor has not published", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).disk.publishedAtMilliseconds.length, 0);
});

Then("the supervisor has published", function (this: ChatticusWorld) {
	assert.ok(supervisorScenarioOf(this).disk.publishedAtMilliseconds.length > 0, "Nothing was published.");
});

Then("the supervisor logged {string} and has not published", function (this: ChatticusWorld, event: string) {
	assert.ok(logLinesOf(this, event).length > 0, `No ${event} line.`);
	assert.equal(supervisorScenarioOf(this).disk.publishedAtMilliseconds.length, 0);
});

Then("the supervisor kills the child", function (this: ChatticusWorld) {
	assert.ok(supervisorScenarioOf(this).spawner.lastChild.signalsReceived.includes("SIGKILL"));
});

Then("it publishes nothing", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).disk.publishedAtMilliseconds.length, 0);
	assert.equal(supervisorScenarioOf(this).plane.stoppedReports.length, 0);
});

Then("the supervisor kills the child and publishes nothing", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.spawner.lastChild.signalsReceived.includes("SIGKILL"));
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 0);
	assert.equal(scenario.plane.stoppedReports.length, 0);
});

Then("the next poll carries sequence {int}", function (this: ChatticusWorld, sequence: number) {
	assert.equal(lastPoll(this).request.sequence, sequence);
});

Then("the following poll carries sequence {int}", function (this: ChatticusWorld, sequence: number) {
	assert.equal(lastPoll(this).request.sequence, sequence);
});

Then("the next poll carries a sequence one higher than the refused one", function (this: ChatticusWorld) {
	const polls = supervisorScenarioOf(this).plane.polls;
	assert.ok(polls.length >= 2);
	const stale = polls.at(-2)?.request.sequence;
	assert.ok(stale !== undefined);
	assert.equal(polls.at(-1)?.request.sequence, stale + 1);
});

Then("its latest poll reported {int} percent of memory in use", function (this: ChatticusWorld, percent: number) {
	assert.equal(lastPoll(this).request.memory_used_percent, percent);
});

Then("the control plane saw {int} stopped reports for generation {int}", function (this: ChatticusWorld, count: number, generation: number) {
	const reports = supervisorScenarioOf(this).plane.stoppedReports;
	assert.equal(reports.length, count);
	assert.ok(reports.every((report) => report.generation === generation));
});

Then("no log line contains the bootstrap token, the supervisor token, the gateway token or any AWS key", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.logs.length > 0, "The supervisor logged nothing.");
	const text = scenario.logs.join("\n");
	for (const secret of allScenarioSecrets()) assert.ok(!text.includes(secret), `A log line contains a secret starting ${secret.slice(0, 8)}.`);
});
