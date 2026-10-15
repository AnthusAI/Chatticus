import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	OWNER_PROTOCOL_VERSION,
	ownerCredentialsResponseSchema,
	type OwnerCredentialsResponse,
	type OwnerErrorCode,
	type OwnerStopReason,
} from "@chatticus/host-protocol/supervisor";
import type { OwnerFileRequest } from "@chatticus/host-protocol/live-files";
import { dispatchPollAnswer, FAKE_SUPERVISOR_SECRETS, ownerRouteRefusal } from "../fakes/fake-supervisor-plane.ts";
import { allIssuedScenarioSecrets, logLinesOf, offerDispatch, supervisorScenarioOf } from "../owner-supervisor-support.ts";
import { awaitOutcome } from "../live-file-supervisor-support.ts";
import type { ChatticusWorld } from "../world.ts";

type SwapSample = { readonly token: string; readonly accessKeyId: string };

type RenewalScenarioState = {
	samples: Promise<SwapSample>[];
	requestPairs: Array<{ readonly route: string; readonly token: string; readonly accessKeyId: string }>;
	readReceivedBy: string | null;
};

const states = new WeakMap<ChatticusWorld, RenewalScenarioState>();

function stateOf(world: ChatticusWorld): RenewalScenarioState {
	let state = states.get(world);
	if (state === undefined) {
		state = { samples: [], requestPairs: [], readReceivedBy: null };
		states.set(world, state);
	}
	return state;
}

const READ_OPERATION_ID = "file-operation-during-renewal";
const FIRST_RENEWAL_SUFFIX = "-renewal-1";

function failureFromText(text: string): Error {
	const refusal = /^(\d+) "(.+)"$/.exec(text);
	if (refusal !== null) return ownerRouteRefusal(Number(refusal[1]), refusal[2] as OwnerErrorCode);
	if (text === "a network error") return new TypeError("fetch failed");
	if (text === "a body that does not parse") {
		const parsed = ownerCredentialsResponseSchema.safeParse({});
		assert.ok(!parsed.success);
		return parsed.error;
	}
	throw new Error(`Unknown renewal failure: ${text}`);
}

function supervisorRenewals(world: ChatticusWorld) {
	return supervisorScenarioOf(world).plane.renewals.filter((recorded) => recorded.request.kind === "supervisor");
}

function turnRenewals(world: ChatticusWorld) {
	return supervisorScenarioOf(world).plane.renewals.filter((recorded) => recorded.request.kind === "turn");
}

function gapsBetween(times: readonly number[]): number[] {
	return times.slice(1).map((time, index) => time - times[index]!);
}

async function probeStorageCredentials(world: ChatticusWorld): Promise<string> {
	const disk = supervisorScenarioOf(world).disk;
	await disk.storageRequest("probe", 0);
	return disk.storageRequests.at(-1)!.accessKeyId;
}

function countOf(text: string): number {
	return text === "once" ? 1 : Number.parseInt(text, 10);
}

Given("the control plane issues credentials that last {int} seconds", function (this: ChatticusWorld, seconds: number) {
	supervisorScenarioOf(this).plane.credentialLifetimeMilliseconds = seconds * 1000;
});

Given("the control plane answers a renewal after {int} seconds", function (this: ChatticusWorld, seconds: number) {
	supervisorScenarioOf(this).plane.renewalDelayMilliseconds = seconds * 1000;
});

Given(/^the control plane answers the first (\d+) renewals with (.+)$/, function (this: ChatticusWorld, count: string, failure: string) {
	const plane = supervisorScenarioOf(this).plane;
	for (let index = 0; index < Number(count); index += 1) plane.renewalScript.push(failureFromText(failure));
});

Given(/^the control plane answers the first renewal with (.+)$/, function (this: ChatticusWorld, answer: string) {
	const scenario = supervisorScenarioOf(this);
	const later = new Date(scenario.clock.nowMilliseconds() + 7200_000).toISOString();
	const earlier = new Date(scenario.clock.nowMilliseconds() + 1000_000).toISOString();
	const credentials = (expiresAt: string) => ({ access_key_id: "unused-key-id", secret_access_key: "unused-secret", session_token: "unused-session", expires_at: expiresAt });
	let response: OwnerCredentialsResponse;
	if (answer === "credentials for a turn instead") {
		response = { kind: "turn", dispatch_id: "dispatch-other", turn_id: "turn-other", gateway_token: "unused-gateway", aws_credentials: credentials(later), expires_at: later };
	} else if (answer === "credentials that end before the ones it holds") {
		response = { kind: "supervisor", supervisor_token: "unused-token", supervisor_token_expires_at: earlier, aws_credentials: credentials(earlier) };
	} else {
		throw new Error(`Unknown renewal answer: ${answer}`);
	}
	scenario.plane.renewalScript.push(response);
});

Given("the control plane answers every renewal with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.renewalsFailWith = ownerRouteRefusal(status, code as OwnerErrorCode);
});

Given("the control plane answers the renewal with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.renewalScript.push(ownerRouteRefusal(status, code as OwnerErrorCode));
});

Given("the control plane answers the first {int} turn credential renewals with {int} {string}", function (this: ChatticusWorld, count: number, status: number, code: string) {
	const plane = supervisorScenarioOf(this).plane;
	for (let index = 0; index < count; index += 1) plane.turnRenewalScript.push(ownerRouteRefusal(status, code as OwnerErrorCode));
});

Given("the control plane answers every turn credential renewal with {int} {string}", function (this: ChatticusWorld, status: number, code: string) {
	supervisorScenarioOf(this).plane.turnRenewalsFailWith = ownerRouteRefusal(status, code as OwnerErrorCode);
});

Given("the control plane approves an idle stop", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).plane.vetoesByReason.delete("idle");
});

Given("a child is serving a turn that never ends on its own", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	scenario.plane.parkedDispatch = dispatchPollAnswer({ turnId: "turn-1" }, scenario.clock);
});

Given("the disk takes {int} seconds to publish", function (this: ChatticusWorld, seconds: number) {
	supervisorScenarioOf(this).disk.publishMilliseconds = seconds * 1000;
});

Given("the disk never finishes publishing", function (this: ChatticusWorld) {
	supervisorScenarioOf(this).disk.publishMilliseconds = Number.POSITIVE_INFINITY;
});

Given(
	"the disk takes {int} seconds to publish in requests of {int} seconds and records the credentials of each storage request",
	function (this: ChatticusWorld, total: number, each: number) {
		const disk = supervisorScenarioOf(this).disk;
		disk.storageRequestsPerPublish = total / each;
		disk.storageRequestMilliseconds = each * 1000;
	},
);

Given("the control plane delivers a read request for {string} in the poll at {int} seconds", function (this: ChatticusWorld, path: string, seconds: number) {
	const scenario = supervisorScenarioOf(this);
	scenario.fileHelper.delayMilliseconds = 500;
	scenario.fileHelper.answerInstead = () => ({ ok: true, contentBase64: Buffer.from("notes").toString("base64") });
	const request: OwnerFileRequest = { operation_id: READ_OPERATION_ID, path, expires_in_ms: 8000, kind: "read", offset: 0, length: 262144, mask: true };
	scenario.plane.timedPollAnswers.push({
		atMilliseconds: scenario.clock.nowMilliseconds() + seconds * 1000,
		answer: { dispatches: [], file_requests: [request], drain: false, next_poll_ms: 1000 },
		deliveredAtMilliseconds: null,
	});
});

When("the control plane dispatches the turn", async function (this: ChatticusWorld) {
	await offerDispatch(this, "turn-1");
});

When("the supervisor's token and storage credentials are sampled after every renewal answer", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const state = stateOf(this);
	const sampleOnce = (): void => {
		state.samples.push(
			(async (): Promise<SwapSample> => {
				const token = scenario.plane.bearerToken;
				const identity = await scenario.disk.credentialsProvider();
				return { token, accessKeyId: identity.accessKeyId };
			})(),
		);
	};
	const sampleForTicks = async (leadingTicks: number): Promise<void> => {
		for (let tick = 0; tick < leadingTicks; tick += 1) await Promise.resolve();
		for (let tick = 0; tick < 20; tick += 1) {
			await Promise.resolve();
			sampleOnce();
		}
	};
	scenario.plane.onRenewalAnswered = () => {
		void sampleForTicks(0);
		void sampleForTicks(1);
	};
	scenario.plane.requestObserver = (route) => {
		const token = scenario.plane.bearerToken;
		void scenario.disk.credentialsProvider().then((identity) => state.requestPairs.push({ route, token, accessKeyId: identity.accessKeyId }));
	};
});

Then("the control plane saw a bootstrap and polls that announce protocol version {int}", function (this: ChatticusWorld, version: number) {
	assert.equal(OWNER_PROTOCOL_VERSION, version);
	const plane = supervisorScenarioOf(this).plane;
	assert.equal(plane.bootstraps[0]?.request.protocol_version, version);
	assert.ok(plane.polls.length > 0);
	assert.ok(plane.polls.every((recorded) => recorded.request.protocol_version === version));
});

Then("the supervisor asked for new supervisor credentials {int} times", function (this: ChatticusWorld, count: number) {
	assert.equal(supervisorRenewals(this).length, count);
});

Then("the supervisor asked for new supervisor credentials once", function (this: ChatticusWorld) {
	assert.equal(supervisorRenewals(this).length, 1, supervisorScenarioOf(this).logs.join(" | "));
});

Then("the supervisor asked for new supervisor credentials once, at {int} seconds", function (this: ChatticusWorld, seconds: number) {
	const scenario = supervisorScenarioOf(this);
	const renewals = supervisorRenewals(this);
	assert.equal(renewals.length, 1);
	assert.equal(renewals[0]!.atMilliseconds - (scenario.plane.bootstraps[0]?.atMilliseconds ?? 0), seconds * 1000);
});

Then(
	"the supervisor asked for new supervisor credentials {int} times, never less than {int} seconds apart",
	function (this: ChatticusWorld, count: number, seconds: number) {
		const renewals = supervisorRenewals(this);
		assert.equal(renewals.length, count);
		for (const gap of gapsBetween(renewals.map((recorded) => recorded.atMilliseconds))) assert.ok(gap >= seconds * 1000, `Two renewals ${gap} milliseconds apart.`);
	},
);

Then(
	"the supervisor asked for new supervisor credentials at least {int} times, never less than {int} seconds apart",
	function (this: ChatticusWorld, count: number, seconds: number) {
		const renewals = supervisorRenewals(this);
		assert.ok(renewals.length >= count, `Only ${renewals.length} renewals.`);
		for (const gap of gapsBetween(renewals.map((recorded) => recorded.atMilliseconds))) assert.ok(gap >= seconds * 1000, `Two renewals ${gap} milliseconds apart.`);
	},
);

Then(
	/^the supervisor asked for new supervisor credentials (\d+) times, (\d+), (\d+), (\d+) and (\d+) seconds apart$/,
	function (this: ChatticusWorld, count: string, first: string, second: string, third: string, fourth: string) {
		const renewals = supervisorRenewals(this);
		assert.equal(renewals.length, Number(count), supervisorScenarioOf(this).logs.join(" | "));
		assert.deepEqual(
			gapsBetween(renewals.map((recorded) => recorded.atMilliseconds)),
			[first, second, third, fourth].map((pause) => Number(pause) * 1000),
		);
	},
);

Then("its next request carried the new supervisor token", function (this: ChatticusWorld) {
	const poll = supervisorScenarioOf(this).plane.requestTokens.filter((request) => request.route === "poll").at(-1);
	assert.equal(poll?.token, `${FAKE_SUPERVISOR_SECRETS.supervisorToken}${FIRST_RENEWAL_SUFFIX}`);
});

Then("the disk was opened once and its storage requests after that carry the new credentials", async function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).diskOpens, 1);
	const accessKeyId = await probeStorageCredentials(this);
	assert.ok(accessKeyId.startsWith(`${FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId}-renewal-`), `The storage request carried ${accessKeyId}.`);
});

Then("the supervisor holds its first credentials and its first token", async function (this: ChatticusWorld) {
	assert.equal(await probeStorageCredentials(this), FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId);
	assert.equal(supervisorScenarioOf(this).plane.bearerToken, FAKE_SUPERVISOR_SECRETS.supervisorToken);
});

Then("the supervisor polled at least every {int} seconds during the renewal", function (this: ChatticusWorld, seconds: number) {
	const plane = supervisorScenarioOf(this).plane;
	const renewal = supervisorRenewals(this)[0];
	assert.ok(renewal, "The supervisor asked for no renewal.");
	const during = plane.polls.map((recorded) => recorded.atMilliseconds).filter((time) => time >= renewal.atMilliseconds - 1000 && time <= renewal.atMilliseconds + plane.renewalDelayMilliseconds + 1000);
	assert.ok(during.length >= 8, `Only ${during.length} polls during the renewal.`);
	for (const gap of gapsBetween(during)) assert.ok(gap <= seconds * 1000, `Two polls ${gap} milliseconds apart.`);
});

Then("it did not fence itself", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.notEqual(scenario.exitCode, 4);
	assert.equal(logLinesOf(this, "owner_stopping").length, 0);
});

Then("the fifth renewal succeeded and the supervisor holds the new credentials", async function (this: ChatticusWorld) {
	assert.equal(supervisorRenewals(this).length, 5);
	assert.equal(await probeStorageCredentials(this), `${FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId}${FIRST_RENEWAL_SUFFIX}`);
	assert.equal(supervisorScenarioOf(this).plane.bearerToken, `${FAKE_SUPERVISOR_SECRETS.supervisorToken}${FIRST_RENEWAL_SUFFIX}`);
});

Then(/^its log holds "([^"]+)" (\d+ times|once) and "([^"]+)" (\d+ times|once)$/, function (this: ChatticusWorld, first: string, firstCount: string, second: string, secondCount: string) {
	assert.equal(logLinesOf(this, first).length, countOf(firstCount), `${first}: ${supervisorScenarioOf(this).logs.join(" | ")}`);
	assert.equal(logLinesOf(this, second).length, countOf(secondCount), `${second}: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then(/^its log holds "([^"]+)" (\d+) times$/, function (this: ChatticusWorld, event: string, count: string) {
	assert.equal(logLinesOf(this, event).length, Number(count));
});

Then(/^its log holds "([^"]+)" for the kind "([^"]+)" (\d+) times$/, function (this: ChatticusWorld, event: string, kind: string, count: string) {
	assert.equal(logLinesOf(this, event).filter((line) => line.includes(`kind=${kind}`)).length, Number(count));
});

Then("the supervisor stopped without publishing and exited with code {int}", function (this: ChatticusWorld, code: number) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.exitCode, code, scenario.logs.join(" | "));
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 0);
	assert.equal(scenario.plane.stoppedReports.length, 0);
});

Then("its log holds {string} with the reason {string}", function (this: ChatticusWorld, event: string, reason: string) {
	assert.ok(logLinesOf(this, event).some((line) => line.includes(`reason=${reason}`)), `No ${event} line with the reason ${reason}. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
});

Then("the supervisor goes on polling and serving with the credentials it holds", async function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.exitCode, null);
	const lastPoll = scenario.plane.polls.at(-1)!;
	assert.ok(scenario.clock.nowMilliseconds() - lastPoll.atMilliseconds <= 1000);
	assert.equal(await probeStorageCredentials(this), FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId);
});

Then("the supervisor reported state {string}", function (this: ChatticusWorld, state: string) {
	assert.ok(supervisorScenarioOf(this).plane.polls.some((recorded) => recorded.request.state === state), `No poll reported ${state}.`);
});

Then("its log holds {string} and {string}", function (this: ChatticusWorld, first: string, second: string) {
	assert.ok(logLinesOf(this, first).length > 0, `No ${first} line.`);
	assert.ok(logLinesOf(this, second).length > 0, `No ${second} line.`);
});

Then("the child was ended and the supervisor asked to stop with reason {string}", function (this: ChatticusWorld, reason: string) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.spawner.children.length > 0 && scenario.spawner.children.every((child) => child.hasExited), "A child is still running.");
	assert.ok(scenario.plane.stopRequests.some((recorded) => recorded.request.reason === reason), `No stop request with the reason ${reason}.`);
});

Then("the disk was published and the computer reported stopped for generation {int}", function (this: ChatticusWorld, generation: number) {
	const scenario = supervisorScenarioOf(this);
	assert.ok(scenario.disk.publishedAtMilliseconds.length > 0, "The disk was not published.");
	assert.deepEqual(scenario.plane.stoppedReports.map((report) => report.generation), [generation]);
});

Then("the supervisor exited with code {int} before {int} seconds after its bootstrap", function (this: ChatticusWorld, code: number, seconds: number) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.exitCode, code, scenario.logs.join(" | "));
	const bootstrappedAt = scenario.plane.bootstraps[0]!.atMilliseconds;
	assert.ok(scenario.exitedAtMilliseconds !== null && scenario.exitedAtMilliseconds - bootstrappedAt < seconds * 1000);
});

Then("the supervisor exited with code {int}", function (this: ChatticusWorld, code: number) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.exitCode, code, scenario.logs.join(" | "));
});

Then("the supervisor asked to stop with reason {string} once", function (this: ChatticusWorld, reason: string) {
	assert.equal(supervisorScenarioOf(this).plane.stopRequests.filter((recorded) => recorded.request.reason === (reason as OwnerStopReason)).length, 1);
});

Then("the supervisor asked to stop with reason {string}", function (this: ChatticusWorld, reason: string) {
	assert.ok(supervisorScenarioOf(this).plane.stopRequests.some((recorded) => recorded.request.reason === (reason as OwnerStopReason)), `No stop request with the reason ${reason}.`);
});

Then("the supervisor asked to stop with reason {string} {int} times", function (this: ChatticusWorld, reason: string, count: number) {
	assert.equal(supervisorScenarioOf(this).plane.stopRequests.filter((recorded) => recorded.request.reason === (reason as OwnerStopReason)).length, count);
});

Then("the disk was never published and no stopped report was made", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	assert.equal(scenario.disk.publishedAtMilliseconds.length, 0);
	assert.equal(scenario.plane.stoppedReports.length, 0);
});

Then("the publish finished without an error", function (this: ChatticusWorld) {
	const disk = supervisorScenarioOf(this).disk;
	assert.deepEqual(disk.publishErrors, []);
	assert.equal(disk.publishedAtMilliseconds.length, 1);
});

Then("the storage requests that began before the renewal carry the first credentials", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const renewedAt = supervisorRenewals(this)[0]!.atMilliseconds;
	const before = scenario.disk.storageRequests.filter((request) => request.startedAtMilliseconds < renewedAt);
	assert.ok(before.length >= 2, `Only ${before.length} requests began before the renewal.`);
	for (const request of before) assert.equal(request.accessKeyId, FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId);
});

Then("the storage requests that began after it carry the renewed credentials", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const renewedAt = supervisorRenewals(this)[0]!.atMilliseconds;
	const after = scenario.disk.storageRequests.filter((request) => request.startedAtMilliseconds >= renewedAt);
	assert.ok(after.length >= 2, `Only ${after.length} requests began after the renewal.`);
	for (const request of after) assert.equal(request.accessKeyId, `${FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId}${FIRST_RENEWAL_SUFFIX}`);
});

Then("a request began before the renewal and ended after it", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const renewedAt = supervisorRenewals(this)[0]!.atMilliseconds;
	assert.ok(scenario.disk.storageRequests.some((request) => request.startedAtMilliseconds < renewedAt && (request.finishedAtMilliseconds ?? 0) > renewedAt));
});

Then("every sample held the old token with the old credentials or the new token with the new credentials", async function (this: ChatticusWorld) {
	const samples = await Promise.all(stateOf(this).samples);
	assert.ok(samples.length >= 40, `Only ${samples.length} samples.`);
	for (const sample of samples) {
		const tokenIsNew = sample.token !== FAKE_SUPERVISOR_SECRETS.supervisorToken;
		const credentialsAreNew = sample.accessKeyId !== FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId;
		assert.equal(tokenIsNew, credentialsAreNew, `A sample held the token ${sample.token} with the credentials ${sample.accessKeyId}.`);
	}
	assert.ok(samples.some((sample) => sample.token !== FAKE_SUPERVISOR_SECRETS.supervisorToken), "No sample saw the new token.");
});

Then("no request the control plane saw carried the new supervisor token while the storage client still used the old credentials", async function (this: ChatticusWorld) {
	await supervisorScenarioOf(this).clock.settle();
	const pairs = stateOf(this).requestPairs;
	assert.ok(pairs.length > 100, `Only ${pairs.length} requests.`);
	for (const pair of pairs) {
		const tokenIsNew = pair.token !== FAKE_SUPERVISOR_SECRETS.supervisorToken;
		const credentialsAreNew = pair.accessKeyId !== FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId;
		assert.equal(tokenIsNew, credentialsAreNew, `A ${pair.route} request carried the token ${pair.token} while the storage client used ${pair.accessKeyId}.`);
	}
});

Then("no request carried the old supervisor token after the first one that carried the new", function (this: ChatticusWorld) {
	const tokens = supervisorScenarioOf(this).plane.requestTokens.map((request) => request.token);
	const firstNew = tokens.findIndex((token) => token !== FAKE_SUPERVISOR_SECRETS.supervisorToken);
	assert.ok(firstNew > 0, "No request carried the new token.");
	assert.ok(tokens.slice(firstNew).every((token) => token !== FAKE_SUPERVISOR_SECRETS.supervisorToken));
});

Then("the supervisor posted the answer to the read request within {int} seconds of receiving it", async function (this: ChatticusWorld, seconds: number) {
	const scenario = supervisorScenarioOf(this);
	await awaitOutcome(this, READ_OPERATION_ID);
	const delivered = scenario.plane.timedPollAnswers[0]?.deliveredAtMilliseconds;
	assert.ok(delivered !== null && delivered !== undefined, "The read request was never delivered.");
	const posted = scenario.plane.fileResults.find((recorded) => recorded.request.operation_id === READ_OPERATION_ID);
	assert.ok(posted, "The answer was never posted.");
	assert.ok(posted.atMilliseconds - delivered <= seconds * 1000, `The answer came ${posted.atMilliseconds - delivered} milliseconds after the request.`);
	const renewal = supervisorRenewals(this)[0]!;
	assert.ok(delivered > renewal.atMilliseconds && delivered < renewal.atMilliseconds + scenario.plane.renewalDelayMilliseconds, "The request did not arrive while the renewal was in flight.");
});

Then("the supervisor asked for new credentials for the dispatched turn once", function (this: ChatticusWorld) {
	const renewals = turnRenewals(this);
	assert.equal(renewals.length, 1, supervisorScenarioOf(this).logs.join(" | "));
	assert.deepEqual(renewals[0]!.request, { kind: "turn", owner_id: "owner-1", generation: 1, dispatch_id: "dispatch-turn-1", turn_id: "turn-1" });
});

Then("the supervisor asked for new credentials for the dispatched turn {int} times", function (this: ChatticusWorld, count: number) {
	assert.equal(turnRenewals(this).length, count, supervisorScenarioOf(this).logs.join(" | "));
});

Then("the turn credential source answers with the renewed credentials for the dispatch and with nothing for another dispatch", function (this: ChatticusWorld) {
	const source = supervisorScenarioOf(this).supervisor!.turnCredentials;
	const held = source.current("dispatch-turn-1");
	assert.ok(held, "The supervisor holds no credentials for the dispatch.");
	assert.ok(held.aws_credentials.access_key_id.startsWith(`${FAKE_SUPERVISOR_SECRETS.turnAccessKeyId}-renewal-`), held.aws_credentials.access_key_id);
	assert.ok(held.gateway_token.startsWith(`${FAKE_SUPERVISOR_SECRETS.gatewayToken}-renewal-`));
	assert.equal(source.current("dispatch-another"), null);
});

Then("the supervisor holds no credentials for any turn", function (this: ChatticusWorld) {
	assert.equal(supervisorScenarioOf(this).supervisor!.turnCredentials.current("dispatch-turn-1"), null);
});

Then("no log line holds the supervisor token, either set of credentials or a gateway token", function (this: ChatticusWorld) {
	const scenario = supervisorScenarioOf(this);
	const secrets = allIssuedScenarioSecrets(this);
	assert.ok(scenario.plane.issuedSecrets.length >= 8, "The control plane issued no renewals.");
	for (const line of scenario.logs) {
		for (const secret of secrets) assert.ok(!line.includes(secret), `A log line holds ${secret.slice(0, 12)}...: ${line}`);
	}
});
