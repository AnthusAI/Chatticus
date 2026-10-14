import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { OWNER_SUPERVISOR_SOCKET_PATH } from "@chatticus/host-protocol/supervisor";
import { SupervisorCredentialsUnavailableError } from "../../../computer/host/src/supervisor-socket-client.ts";
import { FAKE_SUPERVISOR_SECRETS } from "../fakes/fake-supervisor-plane.ts";
import {
	askSocket,
	childAsksTheModelGateway,
	childScenarioOf,
	childUsesStorage,
	childWorksFor,
	DECOY_ENVIRONMENT_ACCESS_KEY_ID,
	prepareChildScenario,
	startChildProgram,
} from "../owner-child-support.ts";
import { allIssuedScenarioSecrets, logLinesOf, serveTurn, startIdleSupervisor, supervisorScenarioOf } from "../owner-supervisor-support.ts";
import type { ChatticusWorld } from "../world.ts";

const SERVED_DISPATCH_ID = "dispatch-turn-1";
const TURN_CREDENTIAL_PREFIX = `${FAKE_SUPERVISOR_SECRETS.turnAccessKeyId}-renewal-`;
const GATEWAY_TOKEN_PREFIX = `${FAKE_SUPERVISOR_SECRETS.gatewayToken}-renewal-`;

type ConnectionState = { readonly socket: Socket; received: string; closed: boolean };

type ConnectionScenarioState = { readonly held: ConnectionState[]; fifth: ConnectionState | null };

const connectionStates = new WeakMap<ChatticusWorld, ConnectionScenarioState>();

function connectionStateOf(world: ChatticusWorld): ConnectionScenarioState {
	let state = connectionStates.get(world);
	if (state === undefined) {
		state = { held: [], fifth: null };
		connectionStates.set(world, state);
	}
	return state;
}

After(function (this: ChatticusWorld) {
	const state = connectionStates.get(this);
	if (state === undefined) return;
	for (const connection of [...state.held, ...(state.fifth === null ? [] : [state.fifth])]) connection.socket.destroy();
	connectionStates.delete(this);
});

function causeChainOf(error: unknown): unknown[] {
	const chain: unknown[] = [];
	for (let current = error; current !== undefined && current !== null && chain.length < 10; current = (current as { cause?: unknown }).cause) chain.push(current);
	return chain;
}

function unavailableReasonOf(error: unknown): string | undefined {
	return causeChainOf(error).find((candidate): candidate is SupervisorCredentialsUnavailableError => candidate instanceof SupervisorCredentialsUnavailableError)?.reason;
}

function request(dispatchId: string, overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ v: 1, op: "turn_credentials", dispatch_id: dispatchId, ...overrides })}\n`;
}

function requestFromText(text: string): Buffer | string {
	switch (text) {
		case "a line that is not JSON":
			return "this is not json\n";
		case "a request for another operation":
			return request(SERVED_DISPATCH_ID, { op: "supervisor_credentials" });
		case "a request with a field the protocol does not have":
			return request(SERVED_DISPATCH_ID, { renew: true });
		case "a request for the dispatch being served with the wrong protocol version":
			return request(SERVED_DISPATCH_ID, { v: 2 });
		case "a request of more than 1024 bytes":
			return request("d".repeat(1100));
		case "a request of more than 1024 bytes that never ends its line":
			return Buffer.alloc(1025, 0x61);
		default:
			throw new Error(`Unknown socket request: ${text}`);
	}
}

function answeredJson(world: ChatticusWorld): Record<string, unknown> {
	const exchange = childScenarioOf(world).exchange;
	assert.ok(exchange?.answer, "The socket gave no answer.");
	return JSON.parse(exchange.answer.trim()) as Record<string, unknown>;
}

function heldTurnCredentials(world: ChatticusWorld) {
	const held = supervisorScenarioOf(world).supervisor?.turnCredentials.current(SERVED_DISPATCH_ID);
	assert.ok(held, "The supervisor holds no credentials for the dispatch it serves.");
	return held;
}

function turnRenewalTimes(world: ChatticusWorld): number[] {
	return supervisorScenarioOf(world)
		.plane.renewals.filter((recorded) => recorded.request.kind === "turn")
		.map((recorded) => recorded.atMilliseconds);
}

function storageRequestsAfter(world: ChatticusWorld, secondsAfterStart: number) {
	const startedAt = supervisorScenarioOf(world).startedAtMilliseconds;
	return childScenarioOf(world)
		.endpoint.requests.filter((recorded) => recorded.service === "dynamodb" || recorded.service === "s3")
		.filter((recorded) => recorded.atMilliseconds - startedAt > secondsAfterStart * 1000);
}

Given("the supervisor serves its child over a socket in a directory only root can enter", async function (this: ChatticusWorld) {
	await prepareChildScenario(this);
});

Given("a supervisor that dispatched a turn to a child", async function (this: ChatticusWorld) {
	await startIdleSupervisor(this);
	await serveTurn(this, "turn-1");
	startChildProgram(this);
});

Given("the supervisor's own environment holds AWS credentials, a gateway token and the container credentials address", function (this: ChatticusWorld) {
	const environment = supervisorScenarioOf(this).environment;
	environment["AWS_ACCESS_KEY_ID"] = "supervisor-environment-access-key";
	environment["AWS_SECRET_ACCESS_KEY"] = "supervisor-environment-secret";
	environment["AWS_SESSION_TOKEN"] = "supervisor-environment-session";
	environment["CHATTICUS_MODEL_GATEWAY_TOKEN"] = "supervisor-environment-gateway-token";
	environment["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"] = "/v2/credentials/supervisor-environment";
});

Given("an earlier supervisor left a stale file at the socket path", function (this: ChatticusWorld) {
	writeFileSync(childScenarioOf(this).socketPath, "left by an earlier supervisor");
});

Given("the child can no longer reach the supervisor's socket", function (this: ChatticusWorld) {
	startChildProgram(this, join(childScenarioOf(this).socketDirectory, "not-the-supervisor.sock"));
});

When("the supervisor stops serving its socket", async function (this: ChatticusWorld) {
	await childScenarioOf(this).server?.close();
});

When("a process asks the socket for the credentials of dispatch {string}", async function (this: ChatticusWorld, dispatchId: string) {
	await askSocket(this, request(dispatchId));
});

When("a process asks the socket for the credentials of the dispatch being served", async function (this: ChatticusWorld) {
	await askSocket(this, request(SERVED_DISPATCH_ID));
});

When(/^a process sends the socket (.+)$/, async function (this: ChatticusWorld, text: string) {
	await askSocket(this, requestFromText(text));
});

When("{int} processes connect to the socket and send nothing", async function (this: ChatticusWorld, count: number) {
	const state = connectionStateOf(this);
	const socketPath = childScenarioOf(this).socketPath;
	for (let index = 0; index < count; index += 1) {
		const connection: ConnectionState = { socket: connect(socketPath), received: "", closed: false };
		connection.socket.on("data", (chunk) => {
			connection.received += chunk.toString("utf8");
		});
		connection.socket.on("close", () => {
			connection.closed = true;
		});
		connection.socket.on("error", () => undefined);
		await new Promise<void>((resolve) => connection.socket.once("connect", () => resolve()));
		state.held.push(connection);
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
});

When("a fifth process connects to the socket", async function (this: ChatticusWorld) {
	const state = connectionStateOf(this);
	const connection: ConnectionState = { socket: connect(childScenarioOf(this).socketPath), received: "", closed: false };
	connection.socket.on("data", (chunk) => {
		connection.received += chunk.toString("utf8");
	});
	connection.socket.on("error", () => undefined);
	state.fifth = connection;
	await new Promise<void>((resolve) => {
		connection.socket.once("close", () => {
			connection.closed = true;
			resolve();
		});
		setTimeout(resolve, 2000);
	});
});

When("the child uses its storage and the model gateway every {int} seconds for {int} seconds", async function (this: ChatticusWorld, every: number, total: number) {
	await childWorksFor(this, total, every);
});

When("the child ends with exit code {int}", async function (this: ChatticusWorld, code: number) {
	supervisorScenarioOf(this).spawner.lastChild.exitWithCode(code);
	await supervisorScenarioOf(this).clock.settle();
});

When("the child sends its next request to the model gateway", async function (this: ChatticusWorld) {
	await childAsksTheModelGateway(this);
});

When("the supervisor renews the credentials of its turn", async function (this: ChatticusWorld) {
	const before = turnRenewalTimes(this).length;
	await supervisorScenarioOf(this).clock.advance(2400_000);
	assert.equal(turnRenewalTimes(this).length, before + 1, "The supervisor did not renew the turn's credentials.");
});

When("the child sends a request to storage", async function (this: ChatticusWorld) {
	const scenario = childScenarioOf(this);
	try {
		await childUsesStorage(this);
	} catch (error) {
		scenario.failure = { error, exitCode: -1, atMilliseconds: supervisorScenarioOf(this).clock.nowMilliseconds() };
	}
});

Then("the supervisor listens on a filesystem socket with mode 0600 in a directory with mode 0700", function (this: ChatticusWorld) {
	const scenario = childScenarioOf(this);
	const file = statSync(scenario.socketPath);
	assert.ok(file.isSocket(), "The path is not a socket.");
	assert.equal((file.mode & 0o777).toString(8), "600");
	assert.equal((statSync(dirname(scenario.socketPath)).mode & 0o777).toString(8), "700");
});

Then("the socket path the child is told is a filesystem path in the runtime directory {string}", function (this: ChatticusWorld, directory: string) {
	assert.equal(dirname(OWNER_SUPERVISOR_SOCKET_PATH), directory);
	assert.ok(OWNER_SUPERVISOR_SOCKET_PATH.startsWith("/"), "The socket path is not a filesystem path.");
	assert.ok(!OWNER_SUPERVISOR_SOCKET_PATH.includes("\0") && !OWNER_SUPERVISOR_SOCKET_PATH.startsWith("@"), "The socket path names an abstract socket.");
});

Then("nothing is left at the socket path", function (this: ChatticusWorld) {
	assert.equal(existsSync(childScenarioOf(this).socketPath), false);
});

Then("the socket closes the connection without an answer", function (this: ChatticusWorld) {
	assert.equal(childScenarioOf(this).exchange?.answer, null);
});

Then("the socket answers {string}", function (this: ChatticusWorld, code: string) {
	assert.deepEqual(answeredJson(this), { ok: false, code });
});

Then("the answer holds no credential", function (this: ChatticusWorld) {
	const answer = childScenarioOf(this).exchange?.answer ?? "";
	for (const secret of allIssuedScenarioSecrets(this)) assert.ok(!answer.includes(secret), "The answer holds a credential.");
	assert.deepEqual(Object.keys(answeredJson(this)).sort(), ["code", "ok"]);
});

Then("the socket answers with the credentials of the turn being served", function (this: ChatticusWorld) {
	const answer = answeredJson(this);
	const held = heldTurnCredentials(this);
	assert.deepEqual(answer, { ok: true, aws_credentials: held.aws_credentials, gateway_token: held.gateway_token, expires_at: held.expires_at });
	assert.equal(held.aws_credentials.access_key_id, FAKE_SUPERVISOR_SECRETS.turnAccessKeyId);
});

Then("the supervisor's log holds {string} with the outcome {string} and no credential value", function (this: ChatticusWorld, event: string, outcome: string) {
	const lines = logLinesOf(this, event).filter((line) => line.includes(`outcome=${outcome}`));
	assert.ok(lines.length > 0, `No ${event} line with the outcome ${outcome}. Log: ${supervisorScenarioOf(this).logs.join(" | ")}`);
	for (const line of lines) for (const secret of allIssuedScenarioSecrets(this)) assert.ok(!line.includes(secret), `A ${event} line holds a credential.`);
});

Then("the supervisor's log holds {string} lines and none carries a token, a key or a credential", function (this: ChatticusWorld, event: string) {
	const lines = logLinesOf(this, event);
	assert.ok(lines.length >= 2, `Expected at least two ${event} lines, saw ${lines.length}.`);
	for (const line of lines) for (const secret of allIssuedScenarioSecrets(this)) assert.ok(!line.includes(secret), `A ${event} line holds a credential.`);
	assert.ok(lines.every((line) => /op=\S+ outcome=\S+/.test(line)), "A socket line does not name its operation and outcome.");
});

Then("the supervisor closes the fifth connection without an answer", function (this: ChatticusWorld) {
	const fifth = connectionStateOf(this).fifth;
	assert.ok(fifth, "No fifth connection was made.");
	assert.equal(fifth.closed, true, "The supervisor did not close the fifth connection.");
	assert.equal(fifth.received, "");
});

Then("the other four connections are still open", function (this: ChatticusWorld) {
	const held = connectionStateOf(this).held;
	assert.equal(held.length, 4);
	for (const connection of held) assert.equal(connection.closed, false, "A held connection was closed.");
});

Then("the child's storage clients and its model gateway requests use the credentials the supervisor holds", async function (this: ChatticusWorld) {
	await childUsesStorage(this);
	await childAsksTheModelGateway(this);
	const held = heldTurnCredentials(this);
	const endpoint = childScenarioOf(this).endpoint;
	const storage = endpoint.requests.filter((recorded) => recorded.service === "dynamodb" || recorded.service === "s3");
	assert.ok(storage.length >= 2, "The child sent fewer than two storage requests.");
	for (const recorded of storage) assert.equal(recorded.accessKeyId, held.aws_credentials.access_key_id);
	const gateway = endpoint.requestsFor("model_gateway");
	assert.ok(gateway.length >= 1, "The child sent no model gateway request.");
	for (const recorded of gateway) assert.equal(recorded.bearerToken, held.gateway_token);
	assert.equal(endpoint.requests.filter((recorded) => recorded.accessKeyId === DECOY_ENVIRONMENT_ACCESS_KEY_ID).length, 0);
});

Then("the child's next request did not fail", function (this: ChatticusWorld) {
	assert.equal(childScenarioOf(this).failure, null, `The child failed: ${String(childScenarioOf(this).failure?.error)}`);
});

Then("the supervisor logged that the child exited clean", function (this: ChatticusWorld) {
	assert.ok(logLinesOf(this, "owner_child_exited").some((line) => line.includes("clean=true")), "The child did not exit clean.");
});

Then("every storage request of the child after {int} seconds carried credentials issued after {int} seconds", function (this: ChatticusWorld, after: number, issuedAfter: number) {
	const startedAt = supervisorScenarioOf(this).startedAtMilliseconds;
	const first = turnRenewalTimes(this)[0];
	assert.ok(first !== undefined && first - startedAt >= issuedAfter * 1000, "The turn's credentials were not renewed after the given time.");
	const late = storageRequestsAfter(this, after);
	assert.ok(late.length > 0, "The child sent no storage request after that time.");
	for (const recorded of late) assert.ok(recorded.accessKeyId?.startsWith(TURN_CREDENTIAL_PREFIX), `A storage request carried ${recorded.accessKeyId}.`);
	const early = storageRequestsAfter(this, 0).filter((recorded) => recorded.atMilliseconds < first);
	for (const recorded of early) assert.equal(recorded.accessKeyId, FAKE_SUPERVISOR_SECRETS.turnAccessKeyId);
});

Then("every model gateway request of the child after {int} seconds carried a token issued after {int} seconds", function (this: ChatticusWorld, after: number, issuedAfter: number) {
	const startedAt = supervisorScenarioOf(this).startedAtMilliseconds;
	const first = turnRenewalTimes(this)[0];
	assert.ok(first !== undefined && first - startedAt >= issuedAfter * 1000, "The turn's credentials were not renewed after the given time.");
	const late = childScenarioOf(this)
		.endpoint.requestsFor("model_gateway")
		.filter((recorded) => recorded.atMilliseconds - startedAt > after * 1000);
	assert.ok(late.length > 0, "The child sent no model gateway request after that time.");
	for (const recorded of late) assert.ok(recorded.bearerToken?.startsWith(GATEWAY_TOKEN_PREFIX), `A gateway request carried ${recorded.bearerToken}.`);
});

Then("the child's next storage request failed for expired credentials", function (this: ChatticusWorld) {
	const failure = childScenarioOf(this).failure;
	assert.ok(failure, "No request of the child failed.");
	assert.equal(unavailableReasonOf(failure.error), "expired", `The failure was ${String(failure.error)}.`);
	const startedAt = supervisorScenarioOf(this).startedAtMilliseconds;
	assert.ok(failure.atMilliseconds - startedAt >= 3600_000, "The request failed before the credentials ended.");
	assert.equal(storageRequestsAfter(this, 3600).length, 0, "A storage request reached the endpoint after the credentials ended.");
});

Then("the child ended with a failure exit code", function (this: ChatticusWorld) {
	assert.equal(childScenarioOf(this).failure?.exitCode, 70);
});

Then("the supervisor logged that the child exited with that code", function (this: ChatticusWorld) {
	assert.ok(logLinesOf(this, "owner_child_exited").some((line) => line.includes("code=70") && line.includes("clean=false")), "The supervisor did not log the child's exit with code 70.");
});

Then("the child never used credentials from its environment or from the container's metadata service", function (this: ChatticusWorld) {
	const endpoint = childScenarioOf(this).endpoint;
	assert.equal(endpoint.requestsFor("decoy").length, 0, "The child asked a credentials endpoint.");
	for (const recorded of endpoint.requests) {
		if (recorded.accessKeyId !== null) assert.ok(recorded.accessKeyId.startsWith(FAKE_SUPERVISOR_SECRETS.turnAccessKeyId), `A request was signed with ${recorded.accessKeyId}.`);
	}
});

Then("the request carried the token the supervisor held when it dispatched the turn", function (this: ChatticusWorld) {
	const requests = childScenarioOf(this).endpoint.requestsFor("model_gateway");
	assert.equal(requests.at(-1)?.bearerToken, FAKE_SUPERVISOR_SECRETS.gatewayToken);
});

Then("the request carried the swapped token", function (this: ChatticusWorld) {
	const requests = childScenarioOf(this).endpoint.requestsFor("model_gateway");
	const swapped = heldTurnCredentials(this).gateway_token;
	assert.notEqual(swapped, FAKE_SUPERVISOR_SECRETS.gatewayToken);
	assert.equal(requests.at(-1)?.bearerToken, swapped);
});

Then("the request failed because the supervisor could not be reached", function (this: ChatticusWorld) {
	const failure = childScenarioOf(this).failure;
	assert.ok(failure, "The request did not fail.");
	assert.equal(unavailableReasonOf(failure.error), "unreachable", `The failure was ${String(failure.error)}.`);
});

Then("storage saw no request from the child", function (this: ChatticusWorld) {
	assert.equal(childScenarioOf(this).endpoint.requests.filter((recorded) => recorded.service === "dynamodb" || recorded.service === "s3").length, 0);
});
