import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createGatewayModels } from "../../../computer/host/src/owner-models.ts";
import { getVendorLedgerEntry } from "../../src/ledger/vendor-ledger.ts";
import { relinquishTurn } from "../../src/domain/turns.ts";
import { mintSessionToken } from "../../src/gateway/session-token.ts";
import { consoleLogEmitter } from "../../src/observability/log-line.ts";
import { ledgerDependenciesFor } from "../executor-harness.ts";
import { httpBaseUrl } from "../front-door.ts";
import { gatewayScenarioOf, SCENARIO_GATEWAY_SIGNING_KEY, SCENARIO_VENDOR_KEY, vendorOf } from "../model-gateway-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { botNamed, claimAs, completeAs, currentTurnId, openChannelOf, postToBot } from "./turn.steps.ts";

const GATEWAY_MODEL = "gpt-5-nano";
const CONTAINER_OWNER = "container-owner";

export type ContainerTurn = { tenantId: string; botId: string; turnId: string; ownerId: string };

const CONTAINER_ATTEMPTS = new WeakMap<ChatticusWorld, string>();

const containerTurns = new WeakMap<ChatticusWorld, ContainerTurn>();
const heldVendors = new WeakMap<ChatticusWorld, () => void>();
const openReaders = new WeakMap<ChatticusWorld, { reader: ReadableStreamDefaultReader<Uint8Array>; text: string }>();
const exchanges = new WeakMap<ChatticusWorld, string[]>();

export function turnOf(world: ChatticusWorld): ContainerTurn {
	const turn = containerTurns.get(world);
	assert.ok(turn, "No container owns a turn in this scenario");
	return turn;
}

const nowSeconds = (world: ChatticusWorld): number => Math.floor(world.clock.now().getTime() / 1000);

function recordExchange(world: ChatticusWorld, response: Response, body: string): void {
	const headers = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
	exchanges.set(world, [...(exchanges.get(world) ?? []), `${headers}\n${body}`]);
}

function remember(world: ChatticusWorld, token: string): void {
	gatewayScenarioOf(world).lastToken = token;
}

function mintFor(world: ChatticusWorld, overrides: Partial<ContainerTurn>, secondsValid: number, key = SCENARIO_GATEWAY_SIGNING_KEY): string {
	return mintSessionToken(key, { ...turnOf(world), ...overrides, expiresAtSeconds: nowSeconds(world) + secondsValid });
}

async function askGateway(world: ChatticusWorld, tenantId: string, token: string | null): Promise<void> {
	const scenario = gatewayScenarioOf(world);
	const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	const response = await fetch(`${await httpBaseUrl(world)}/orgs/${tenantId}/model-gateway/v1/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: GATEWAY_MODEL, stream: true, input: [{ role: "user", content: "Say good morning." }] }),
	});
	const body = await response.text();
	recordExchange(world, response, body);
	scenario.lastResponse = response;
	scenario.lastBody = body;
}

Given("bot {string} has an active turn owned by a container owner", async function (this: ChatticusWorld, name: string) {
	await postToBot(this, name, "hello", true);
	const channel = openChannelOf(this);
	const claim = await claimAs(this, channel.tenantId, currentTurnId(this), CONTAINER_OWNER);
	assert.ok(claim, "The container could not claim the turn");
	containerTurns.set(this, {
		tenantId: channel.tenantId,
		botId: botNamed(this, name).botId,
		turnId: currentTurnId(this),
		ownerId: CONTAINER_OWNER,
	});
	CONTAINER_ATTEMPTS.set(this, claim.attemptId);
});

Given(
	"the vendor answers {string} using {int} input tokens and {int} output tokens",
	async function (this: ChatticusWorld, text: string, inputTokens: number, outputTokens: number) {
		(await vendorOf(this)).answer(text, { inputTokens, outputTokens });
	},
);

Given("the container holds a session token for its turn valid for {int} seconds", function (this: ChatticusWorld, seconds: number) {
	remember(this, mintFor(this, {}, seconds));
});

Given("the container changes the turn named in its token without re-signing", function (this: ChatticusWorld) {
	const scenario = gatewayScenarioOf(this);
	const [version, claims, signature] = scenario.lastToken.split(".") as [string, string, string];
	const changed = { ...JSON.parse(Buffer.from(claims, "base64url").toString("utf8")), turnId: "another-turn" };
	remember(this, [version, Buffer.from(JSON.stringify(changed)).toString("base64url"), signature].join("."));
});

Given("the container holds a session token for its turn signed with another key", function (this: ChatticusWorld) {
	remember(this, mintFor(this, {}, 300, "a-different-signing-key-0123456789abcdef"));
});

Given("the container holds a session token for a turn that does not exist", function (this: ChatticusWorld) {
	remember(this, mintFor(this, { turnId: "turn-that-does-not-exist" }, 300));
});

Given("the container holds a session token for its turn bound to another owner", function (this: ChatticusWorld) {
	remember(this, mintFor(this, { ownerId: "owner-of-someone-else" }, 300));
});

Given(
	"the container's lease runs out and the owner {string} takes the turn over",
	async function (this: ChatticusWorld, owner: string) {
		const turn = turnOf(this);
		this.clock.advanceSeconds(61);
		const claim = await claimAs(this, turn.tenantId, turn.turnId, owner);
		assert.ok(claim, `The owner ${owner} could not take the turn over`);
		assert.notEqual(claim.attemptId, CONTAINER_ATTEMPTS.get(this));
	},
);

Given("the owner {string} holds a session token for the turn valid for {int} seconds", function (this: ChatticusWorld, owner: string, seconds: number) {
	remember(this, mintFor(this, { ownerId: owner }, seconds));
});

Given("the container's turn is released without an owner", async function (this: ChatticusWorld) {
	const turn = turnOf(this);
	await relinquishTurn(this.turnDependencies(), turn.tenantId, turn.turnId, CONTAINER_ATTEMPTS.get(this)!);
});

Given("the container holds a session token for its turn naming the bot {string}", function (this: ChatticusWorld, name: string) {
	remember(this, mintFor(this, { botId: botNamed(this, name).botId }, 300));
});

Given(
	"the container holds a session token for organization {string} naming its turn",
	function (this: ChatticusWorld, tenantId: string) {
		remember(this, mintFor(this, { tenantId }, 300));
	},
);

Given("the container's turn has completed", async function (this: ChatticusWorld) {
	const turn = turnOf(this);
	await completeAs(this, turn.tenantId, turn.turnId, CONTAINER_ATTEMPTS.get(this)!, "All done.");
});

Given("the vendor holds its answer back after the first text delta", async function (this: ChatticusWorld) {
	heldVendors.set(this, (await vendorOf(this)).holdAfterEvents(4));
});

Given("the vendor refuses the next request with its own error text that echoes the key", async function (this: ChatticusWorld) {
	(await vendorOf(this)).failWith(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${SCENARIO_VENDOR_KEY}.` } }));
});

When("the container asks the model gateway for an answer", async function (this: ChatticusWorld) {
	await askGateway(this, turnOf(this).tenantId, gatewayScenarioOf(this).lastToken);
});

When("the container asks the model gateway for an answer without a token", async function (this: ChatticusWorld) {
	await askGateway(this, turnOf(this).tenantId, null);
});

When("the container asks the model gateway of organization {string} for an answer", async function (this: ChatticusWorld, tenantId: string) {
	await askGateway(this, tenantId, gatewayScenarioOf(this).lastToken);
});

When("the container asks the model gateway for an answer and reads only the start", async function (this: ChatticusWorld) {
	const response = await fetch(`${await httpBaseUrl(this)}/orgs/${turnOf(this).tenantId}/model-gateway/v1/responses`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${gatewayScenarioOf(this).lastToken}` },
		body: JSON.stringify({ model: GATEWAY_MODEL, stream: true, input: [] }),
	});
	assert.equal(response.status, 200);
	gatewayScenarioOf(this).lastResponse = response;
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const state = { reader, text: "" };
	while (!state.text.includes("response.output_text.delta")) {
		const chunk = await reader.read();
		assert.ok(!chunk.done, "The answer ended before its first text delta");
		state.text += decoder.decode(chunk.value, { stream: true });
	}
	openReaders.set(this, state);
});

When("the vendor lets the rest of the answer go", async function (this: ChatticusWorld) {
	const release = heldVendors.get(this);
	const state = openReaders.get(this);
	assert.ok(release && state, "No held answer is being read");
	release();
	const decoder = new TextDecoder();
	for (;;) {
		const chunk = await state.reader.read();
		if (chunk.done) break;
		state.text += decoder.decode(chunk.value, { stream: true });
	}
	gatewayScenarioOf(this).lastBody = state.text;
});

When(
	"a Pi model collection pointed at the vendor address with the token {string} asks for an answer",
	async function (this: ChatticusWorld, token: string) {
		await askWithPi(this, (await vendorOf(this)).baseUrl, token);
	},
);

When("a Pi model collection pointed at the gateway with the container's token asks for an answer", async function (this: ChatticusWorld) {
	const baseUrl = `${await httpBaseUrl(this)}/orgs/${turnOf(this).tenantId}/model-gateway/v1`;
	await askWithPi(this, baseUrl, gatewayScenarioOf(this).lastToken);
});

When(
	"a Pi model collection pointed at the vendor address with the token {string} and the invoke key {string} asks for an answer",
	async function (this: ChatticusWorld, token: string, invokeKey: string) {
		await askWithPi(this, (await vendorOf(this)).baseUrl, token, invokeKey);
	},
);

const piAnswers = new WeakMap<ChatticusWorld, string>();

When(
	"a Pi model collection pointed at the gateway with the container's token asks for an answer and logs as its owner",
	async function (this: ChatticusWorld) {
		const turn = turnOf(this);
		const baseUrl = `${await httpBaseUrl(this)}/orgs/${turn.tenantId}/model-gateway/v1`;
		const models = createGatewayModels(
			{ baseUrl, token: gatewayScenarioOf(this).lastToken },
			consoleLogEmitter({ tenant_id: turn.tenantId, turn_id: turn.turnId, owner_id: turn.ownerId }),
		);
		const model = models.getModel("openai", GATEWAY_MODEL);
		assert.ok(model, "Pi has no model to ask");
		const answer = await models.complete(model, { messages: [{ role: "user", content: "Say good morning.", timestamp: Date.now() }] });
		piAnswers.set(
			this,
			answer.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		);
	},
);

async function askWithPi(world: ChatticusWorld, baseUrl: string, token: string, invokeKey?: string): Promise<void> {
	const models = createGatewayModels({ baseUrl, token, ...(invokeKey === undefined ? {} : { invokeKey }) });
	const model = models.getModel("openai", GATEWAY_MODEL);
	assert.ok(model, "Pi has no model to ask");
	const answer = await models.complete(model, { messages: [{ role: "user", content: "Say good morning.", timestamp: Date.now() }] });
	assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
	piAnswers.set(
		world,
		answer.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
	);
}

Then("Pi received the answer {string}", function (this: ChatticusWorld, text: string) {
	assert.equal(piAnswers.get(this), text);
});

Then("the vendor saw the authorization {string}", async function (this: ChatticusWorld, authorization: string) {
	const requests = (await vendorOf(this)).requests;
	assert.equal(requests[requests.length - 1]?.headers.authorization, authorization);
});

Then("the vendor saw the invoke key header {string}", async function (this: ChatticusWorld, invokeKey: string) {
	const requests = (await vendorOf(this)).requests;
	assert.equal(requests[requests.length - 1]?.headers["x-chatticus-invoke-key"], invokeKey);
});

Then("the vendor saw no invoke key header", async function (this: ChatticusWorld) {
	const requests = (await vendorOf(this)).requests;
	assert.ok(requests.length > 0, "The vendor received no request");
	assert.equal(requests[requests.length - 1]?.headers["x-chatticus-invoke-key"], undefined);
});

Then("the vendor saw the real key and not the session token", async function (this: ChatticusWorld) {
	const requests = (await vendorOf(this)).requests;
	const last = requests[requests.length - 1];
	assert.ok(last, "The vendor received no request");
	assert.equal(last.headers.authorization, `Bearer ${SCENARIO_VENDOR_KEY}`);
	const token = gatewayScenarioOf(this).lastToken;
	assert.ok(token === "" || !JSON.stringify(last).includes(token), "The session token reached the vendor");
});

Then("the gateway answers with status {int}", function (this: ChatticusWorld, status: number) {
	const response = gatewayScenarioOf(this).lastResponse;
	assert.ok(response, "The gateway was not asked");
	assert.equal(response.status, status, gatewayScenarioOf(this).lastBody);
});

Then("the container receives the answer text {string}", function (this: ChatticusWorld, text: string) {
	const body = gatewayScenarioOf(this).lastBody;
	assert.ok(body.includes("response.completed"), body);
	const deltas = [...body.matchAll(/"type":"response\.output_text\.delta"[^\n]*?"delta":"([^"]*)"/g)].map((match) => match[1]);
	assert.equal(deltas.join(""), text);
});

Then("the start of the answer reaches the container while the vendor is still answering", function (this: ChatticusWorld) {
	const state = openReaders.get(this);
	assert.ok(state, "No answer is being read");
	assert.ok(state.text.includes("response.output_text.delta"));
	assert.ok(!state.text.includes("response.completed"), "The gateway held the start back until the end");
});

Then("the vendor received exactly {int} request(s)", async function (this: ChatticusWorld, count: number) {
	assert.equal((await vendorOf(this)).requests.length, count);
});

Then("no request reached the vendor", async function (this: ChatticusWorld) {
	assert.equal((await vendorOf(this)).requests.length, 0);
});

Then(
	"the vendor ledger holds {int} input tokens and {int} output tokens for the turn",
	async function (this: ChatticusWorld, inputTokens: number, outputTokens: number) {
		const turn = turnOf(this);
		const row = await getVendorLedgerEntry(ledgerDependenciesFor(this), turn.tenantId, turn.turnId);
		assert.ok(row, "The vendor ledger has no row for the turn");
		assert.equal(row.inputTokens, inputTokens);
		assert.equal(row.outputTokens, outputTokens);
		assert.equal(row.vendor, "openai");
		assert.equal(row.model, GATEWAY_MODEL);
	},
);

Then("the vendor ledger holds no spend for the turn", async function (this: ChatticusWorld) {
	const turn = turnOf(this);
	assert.equal(await getVendorLedgerEntry(ledgerDependenciesFor(this), turn.tenantId, turn.turnId), null);
});

Then("the gateway recorded spend {int} time(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(gatewayScenarioOf(this).logEvents.filter((event) => event.event === "spend_recorded").length, count);
});

Then("the error says the model provider request failed", function (this: ChatticusWorld) {
	assert.equal(JSON.parse(gatewayScenarioOf(this).lastBody).detail, "model provider request failed");
});

Then("the real key appears in no response body, response header or log event of the gateway", function (this: ChatticusWorld) {
	const seen = exchanges.get(this) ?? [];
	assert.ok(seen.length >= 3, "Too few exchanges were observed to prove anything");
	for (const exchange of seen) assert.ok(!exchange.includes(SCENARIO_VENDOR_KEY), `A response carried the key:\n${exchange}`);
	const logged = gatewayScenarioOf(this).consoleLines.join("\n");
	assert.ok(logged.length > 0, "The gateway logged nothing");
	assert.ok(!logged.includes(SCENARIO_VENDOR_KEY), `A log event carried the key:\n${logged}`);
});
