import assert from "node:assert/strict";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After } from "@cucumber/cucumber";
import { createContainerOwnerDeps, ownerStoresConfigFromEnvironment } from "../../computer/host/src/owner-deps.ts";
import { ownerChildExitCodeForError } from "../../computer/host/src/owner.ts";
import { SupervisorSocketClient, turnCredentialProviders } from "../../computer/host/src/supervisor-socket-client.ts";
import { SupervisorSocketServer } from "../../computer/host/src/supervisor-socket.ts";
import type { ExecutorDeps } from "../src/turn/types.ts";
import { formatLogLine } from "../src/observability/log-line.ts";
import { RecordingAwsEndpoint } from "./fakes/recording-aws-endpoint.ts";
import { supervisorScenarioOf } from "./owner-supervisor-support.ts";
import type { ChatticusWorld } from "./world.ts";

/** The access key the process environment of the scenario holds and the child must never sign with. */
export const DECOY_ENVIRONMENT_ACCESS_KEY_ID = "decoy-access-key-from-the-process-environment";

/** The path of the endpoint standing in for the container credentials endpoint and the instance metadata service; the child must never request it. */
const DECOY_CONTAINER_CREDENTIALS_PATH = "/decoy-container-credentials";
const DECOY_INSTANCE_METADATA_PATH = "/decoy-instance-metadata";

/** What a request to the supervisor's socket ended with: the one line it answered, or nothing before it closed the connection. */
export type SocketExchange = { readonly answer: string | null };

/** The program a scenario runs as the per-turn child: the production wiring of its clients, over the scenario's socket and endpoint. */
export type ChildProgram = {
	readonly dispatchId: string;
	readonly deps: ExecutorDeps;
};

/** What one child scenario holds between its steps. */
export type ChildScenario = {
	readonly socketDirectory: string;
	readonly socketPath: string;
	readonly endpoint: RecordingAwsEndpoint;
	server: SupervisorSocketServer | null;
	program: ChildProgram | null;
	/** The error the child's first failed request raised, and the exit code the entry point would map it to. */
	failure: { readonly error: unknown; readonly exitCode: number; readonly atMilliseconds: number } | null;
	exchange: SocketExchange | null;
	readonly savedEnvironment: Map<string, string | undefined>;
	savedDateNow: (() => number) | null;
};

const scenarios = new WeakMap<ChatticusWorld, ChildScenario>();

/** The scenario's child state; the Background creates it. */
export function childScenarioOf(world: ChatticusWorld): ChildScenario {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "The scenario has no child state; its Background should create it.");
	return scenario;
}

function setEnvironment(scenario: ChildScenario, name: string, value: string): void {
	if (!scenario.savedEnvironment.has(name)) scenario.savedEnvironment.set(name, process.env[name]);
	process.env[name] = value;
}

/**
 * Prepare a scenario in which the supervisor serves its child over a socket: a directory only its owner can enter, a
 * recording endpoint the real AWS clients are pointed at, a process environment that holds credentials the child must never
 * use, and the time the SDK reads moved onto the scenario's clock. The socket server is attached to the supervisor when it starts.
 */
export async function prepareChildScenario(world: ChatticusWorld): Promise<ChildScenario> {
	const supervisorScenario = supervisorScenarioOf(world);
	const socketDirectory = mkdtempSync(join(tmpdir(), "cs-"));
	chmodSync(socketDirectory, 0o700);
	const endpoint = new RecordingAwsEndpoint(() => supervisorScenario.clock.nowMilliseconds());
	await endpoint.start();
	const scenario: ChildScenario = {
		socketDirectory,
		socketPath: join(socketDirectory, "supervisor.sock"),
		endpoint,
		server: null,
		program: null,
		failure: null,
		exchange: null,
		savedEnvironment: new Map(),
		savedDateNow: Date.now,
	};
	scenarios.set(world, scenario);
	setEnvironment(scenario, "AWS_ENDPOINT_URL", endpoint.baseUrl);
	setEnvironment(scenario, "AWS_REGION", "us-east-1");
	setEnvironment(scenario, "AWS_ACCESS_KEY_ID", DECOY_ENVIRONMENT_ACCESS_KEY_ID);
	setEnvironment(scenario, "AWS_SECRET_ACCESS_KEY", "decoy-secret-from-the-process-environment");
	setEnvironment(scenario, "AWS_SESSION_TOKEN", "decoy-session-from-the-process-environment");
	setEnvironment(scenario, "AWS_CONTAINER_CREDENTIALS_FULL_URI", `${endpoint.baseUrl}${DECOY_CONTAINER_CREDENTIALS_PATH}`);
	setEnvironment(scenario, "AWS_EC2_METADATA_SERVICE_ENDPOINT", `${endpoint.baseUrl}${DECOY_INSTANCE_METADATA_PATH}`);
	Date.now = () => supervisorScenario.clock.nowMilliseconds();
	supervisorScenario.beforeSupervisorRuns = async (supervisor) => {
		scenario.server = new SupervisorSocketServer({
			socketPath: scenario.socketPath,
			source: supervisor.turnCredentials,
			serving: () => supervisor.servingTurn,
			nowMilliseconds: () => supervisorScenario.clock.nowMilliseconds(),
			log: (event, fields = {}) => supervisorScenario.logs.push(formatLogLine(event, { tenant_id: "anthus", owner_id: "owner-1", ...fields })),
		});
		await scenario.server.start();
	};
	return scenario;
}

After(async function (this: ChatticusWorld) {
	const scenario = scenarios.get(this);
	if (scenario === undefined) return;
	scenarios.delete(this);
	await scenario.server?.close();
	await scenario.endpoint.stop();
	if (scenario.savedDateNow !== null) Date.now = scenario.savedDateNow;
	for (const [name, value] of scenario.savedEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(scenario.socketDirectory, { recursive: true, force: true });
});

/**
 * Start the per-turn child's clients the way the owner program builds them: its stores configuration from the environment the
 * supervisor made for it, and the executor's dependencies over providers that ask the supervisor's socket. Only the socket's
 * path and the gateway's address are the scenario's own.
 *
 * @param socketPath Where the child asks. Defaults to the scenario's socket.
 */
export function startChildProgram(world: ChatticusWorld, socketPath?: string): ChildProgram {
	const scenario = childScenarioOf(world);
	const child = supervisorScenarioOf(world).spawner.lastChild;
	const dispatchId = child.environment["CHATTICUS_DISPATCH_ID"];
	assert.ok(dispatchId, "The child's environment names no dispatch.");
	const providers = turnCredentialProviders(new SupervisorSocketClient({ socketPath: socketPath ?? scenario.socketPath, dispatchId }));
	const stores = ownerStoresConfigFromEnvironment({ ...child.environment, CHATTICUS_MODEL_GATEWAY_URL: `${scenario.endpoint.baseUrl}/v1` }, providers.gatewayToken);
	scenario.program = { dispatchId, deps: createContainerOwnerDeps(stores, providers.awsCredentials) };
	return scenario.program;
}

function programOf(world: ChatticusWorld): ChildProgram {
	const program = childScenarioOf(world).program;
	assert.ok(program, "No child program is running.");
	return program;
}

/** The child reads one item from its table and one object from its bucket, each through the real SDK client it was built with. */
export async function childUsesStorage(world: ChatticusWorld): Promise<void> {
	const { deps } = programOf(world);
	await deps.client.send(new GetItemCommand({ TableName: "messaging", Key: { pk: { S: "probe" } } }));
	await deps.s3.send(new HeadObjectCommand({ Bucket: "pi-sessions", Key: "probe" }));
}

/** The child sends one request to the model gateway through the model collection it was built with; the endpoint refuses it after recording it. */
export async function childAsksTheModelGateway(world: ChatticusWorld): Promise<void> {
	const { deps } = programOf(world);
	const model = deps.models.getModel("openai", "gpt-5-nano");
	assert.ok(model, "Pi has no model to ask");
	await deps.models.complete(model, { messages: [{ role: "user", content: "probe", timestamp: Date.now() }] });
}

/**
 * The child does its work for the span of a tool: every step seconds the clock moves, then it uses its storage and the model
 * gateway. The first request that fails ends the child as the owner program ends it, with the exit code its error maps to.
 * The supervisor sees the child exit with that code.
 */
export async function childWorksFor(world: ChatticusWorld, totalSeconds: number, everySeconds: number): Promise<void> {
	const supervisorScenario = supervisorScenarioOf(world);
	const scenario = childScenarioOf(world);
	for (let elapsed = 0; elapsed < totalSeconds && scenario.failure === null; elapsed += everySeconds) {
		await supervisorScenario.clock.advance(everySeconds * 1000);
		try {
			await childUsesStorage(world);
			await childAsksTheModelGateway(world);
		} catch (error) {
			scenario.failure = { error, exitCode: ownerChildExitCodeForError(error), atMilliseconds: supervisorScenario.clock.nowMilliseconds() };
			supervisorScenario.spawner.lastChild.exitWithCode(scenario.failure.exitCode);
			await supervisorScenario.clock.settle();
		}
	}
}

/** Send raw bytes to the supervisor's socket and read until the line it answers or until it closes the connection. */
export async function askSocket(world: ChatticusWorld, bytes: Buffer | string): Promise<SocketExchange> {
	const scenario = childScenarioOf(world);
	const exchange = await new Promise<SocketExchange>((resolve) => {
		const connection = connect(scenario.socketPath);
		let received = "";
		connection.on("connect", () => connection.write(bytes));
		connection.on("data", (chunk) => {
			received += chunk.toString("utf8");
		});
		connection.on("error", () => resolve({ answer: received === "" ? null : received }));
		connection.on("close", () => resolve({ answer: received === "" ? null : received }));
	});
	scenario.exchange = exchange;
	await supervisorScenarioOf(world).clock.settle();
	return exchange;
}
