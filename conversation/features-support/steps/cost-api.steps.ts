import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { COST_ERROR_CODES } from "@chatticus/host-protocol/costs";
import { Decimal } from "../../src/budget/decimal.ts";
import { bearerFor } from "../front-door.ts";
import { ensureMember, memberHeadersFor } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";

const TENANT = "anthus";

type CostResponse = { status: number; json: any; text: string; headers: Headers };

type CostScenario = { response: CostResponse | null; channels: Map<string, string> };

const scenarios = new WeakMap<ChatticusWorld, CostScenario>();

function scenarioOf(world: ChatticusWorld): CostScenario {
	let found = scenarios.get(world);
	if (found === undefined) {
		found = { response: null, channels: new Map() };
		scenarios.set(world, found);
	}
	return found;
}

function responseOf(world: ChatticusWorld): CostResponse {
	const response = scenarioOf(world).response;
	assert.ok(response, "No cost request has been made in this scenario.");
	return response;
}

function substitute(world: ChatticusWorld, text: string): string {
	return text
		.replaceAll(/\{bot:([^}]+)\}/g, (_, name: string) => {
			const bot = world.botsByName?.get(name);
			assert.ok(bot, `Bot ${name} not found`);
			return bot.botId;
		})
		.replaceAll("{channel}", () => {
			assert.ok(world.lastChannel, "The scenario has no channel.");
			return world.lastChannel.channelId;
		})
		.replaceAll("{turn}", () => {
			assert.ok(world.lastTurnId, "The scenario has no turn.");
			return world.lastTurnId;
		})
		.replaceAll("{cursor}", () => {
			const cursor = responseOf(world).json?.next_cursor;
			assert.ok(typeof cursor === "string", "The last response has no next_cursor.");
			return cursor;
		});
}

async function send(world: ChatticusWorld, path: string, headers: Record<string, string>): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const response = await world.api.get(path, { headers });
	const text = await response.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	scenarioOf(world).response = { status: response.status, json, text, headers: response.headers };
}

async function promptAndReplySequences(world: ChatticusWorld): Promise<{ prompt: number; reply: number }> {
	assert.ok(world.lastTurnId, "The scenario has no turn.");
	const turn = await world.turnDependencies().store.getTurn(world.lastChannel?.tenantId ?? TENANT, world.lastTurnId);
	assert.ok(turn, "The turn does not exist.");
	assert.ok(turn.promptMessageSeq !== null && turn.messageSeq !== null, `The turn has not replied: ${JSON.stringify(turn)}`);
	return { prompt: turn.promptMessageSeq, reply: turn.messageSeq };
}

type CostSubject = "turn" | "channel" | "prompt message" | "reply message";

async function pathFor(world: ChatticusWorld, subject: CostSubject, tenantId: string): Promise<string> {
	const channelId = world.lastChannel?.channelId;
	switch (subject) {
		case "turn":
			assert.ok(world.lastTurnId, "The scenario has no turn.");
			return `/orgs/${tenantId}/turns/${world.lastTurnId}/cost`;
		case "channel":
			return `/orgs/${tenantId}/channels/${channelId}/cost`;
		case "prompt message":
			return `/orgs/${tenantId}/channels/${channelId}/messages/${(await promptAndReplySequences(world)).prompt}/cost`;
		case "reply message":
			return `/orgs/${tenantId}/channels/${channelId}/messages/${(await promptAndReplySequences(world)).reply}/cost`;
	}
}

Given("user {string} is an ordinary member of tenant {string}", async function (this: ChatticusWorld, userId: string, tenantId: string) {
	await ensureMember(this, tenantId, userId, "member");
});

When("member {string} gets {string}", async function (this: ChatticusWorld, userId: string, path: string) {
	await send(this, `/orgs/${TENANT}${substitute(this, path)}`, await memberHeadersFor(this, TENANT, userId));
});

When(
	/^member "([^"]+)" gets the cost of the (turn|channel|prompt message|reply message)(?: of the channel)?$/,
	async function (this: ChatticusWorld, userId: string, subject: CostSubject) {
		await send(this, await pathFor(this, subject, TENANT), await memberHeadersFor(this, TENANT, userId));
	},
);

When(
	"user {string} of tenant {string} gets {string} of tenant {string}",
	async function (this: ChatticusWorld, userId: string, homeTenant: string, path: string, targetTenant: string) {
		await send(this, `/orgs/${targetTenant}${substitute(this, path)}`, await memberHeadersFor(this, homeTenant, userId));
	},
);

When(
	/^user "([^"]+)" of tenant "([^"]+)" gets the cost of the (turn|channel|prompt message) (?:of the channel )?of tenant "([^"]+)"$/,
	async function (this: ChatticusWorld, userId: string, homeTenant: string, subject: CostSubject, targetTenant: string) {
		await send(this, await pathFor(this, subject, targetTenant), await memberHeadersFor(this, homeTenant, userId));
	},
);

When("a caller with no credential gets {string} of tenant {string}", async function (this: ChatticusWorld, path: string, tenantId: string) {
	await send(this, `/orgs/${tenantId}${path}`, {});
});

When("a signed-in stranger with no organization gets {string} of tenant {string}", async function (this: ChatticusWorld, path: string, tenantId: string) {
	await send(this, `/orgs/${tenantId}${path}`, await bearerFor(this, "stranger@nowhere.test"));
});

When("the channel is remembered as {string}", function (this: ChatticusWorld, label: string) {
	assert.ok(this.lastChannel, "The scenario has no channel.");
	scenarioOf(this).channels.set(label, this.lastChannel.channelId);
});

When(
	"member {string} compares the remembered channels {string} and {string}",
	async function (this: ChatticusWorld, userId: string, first: string, second: string) {
		const channels = scenarioOf(this).channels;
		const firstId = channels.get(first);
		const secondId = channels.get(second);
		assert.ok(firstId && secondId, "A channel was not remembered.");
		await send(this, `/orgs/${TENANT}/costs/compare?channel_id=${firstId}&channel_id=${secondId}`, await memberHeadersFor(this, TENANT, userId));
	},
);

Then("the cost response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = responseOf(this);
	assert.equal(response.status, status, response.text);
	if (status >= 400 && response.json !== null && response.json.error !== undefined) {
		assert.ok((COST_ERROR_CODES as readonly string[]).includes(response.json.error), response.text);
	}
});

Then("the cost response is private and not stored", function (this: ChatticusWorld) {
	assert.equal(responseOf(this).headers.get("Cache-Control"), "private, no-store");
});

const SEGMENT = /^([A-Za-z_]+)(?:\[([a-z_]+)=([^\]]*)\])?$/;

function fieldOf(root: unknown, path: string): unknown {
	let current: any = root;
	for (const segment of path.split(/\.(?![^\[]*\])/)) {
		if (/^\d+$/.test(segment)) {
			assert.ok(Array.isArray(current), `${path}: ${segment} is not an index into a list`);
			current = current[Number(segment)];
			continue;
		}
		const parsed = SEGMENT.exec(segment);
		assert.ok(parsed, `${path}: cannot read segment ${segment}`);
		const [, name, selectorField, selectorValue] = parsed;
		assert.ok(current !== null && typeof current === "object", `${path}: nothing at ${name}`);
		current = current[name!];
		if (selectorField !== undefined) {
			assert.ok(Array.isArray(current), `${path}: ${name} is not a list`);
			const wanted = selectorValue === "null" ? null : selectorValue;
			current = current.find((item: any) => item[selectorField] === wanted);
			assert.ok(current !== undefined, `${path}: no item of ${name} has ${selectorField}=${selectorValue}`);
		}
	}
	return current;
}

Then("the response field {string} is {string}", function (this: ChatticusWorld, path: string, expected: string) {
	const value = fieldOf(responseOf(this).json, substitute(this, path));
	assert.equal(String(value), substitute(this, expected), `${path}: ${JSON.stringify(value)}`);
});

Then("the response field {string} is null", function (this: ChatticusWorld, path: string) {
	assert.equal(fieldOf(responseOf(this).json, substitute(this, path)), null, path);
});

Then("the response field {string} is present", function (this: ChatticusWorld, path: string) {
	const value = fieldOf(responseOf(this).json, path);
	assert.ok(typeof value === "string" && value.length > 0, `${path}: ${JSON.stringify(value)}`);
});

Then("the response field {string} is the id of bot {string}", function (this: ChatticusWorld, path: string, name: string) {
	assert.equal(fieldOf(responseOf(this).json, path), this.botsByName?.get(name)?.botId);
});

Then("the response field {string} is the id of the channel", function (this: ChatticusWorld, path: string) {
	assert.equal(fieldOf(responseOf(this).json, path), this.lastChannel?.channelId);
});

Then("the response list {string} has {int} items", function (this: ChatticusWorld, path: string, count: number) {
	const value = fieldOf(responseOf(this).json, path);
	assert.ok(Array.isArray(value), `${path} is not a list`);
	assert.equal(value.length, count, JSON.stringify(value));
});

const decimalOf = (value: unknown): Decimal => Decimal.parse(String(value));

const sumOf = (items: any[], select: (item: any) => unknown): Decimal => items.reduce((total, item) => total.add(decimalOf(select(item))), Decimal.zero());

Then("the calls of the response add up to its totals", function (this: ChatticusWorld) {
	const json = responseOf(this).json;
	assert.ok(sumOf(json.calls, (call) => call.cost_usd).equals(decimalOf(json.totals.cost_usd)), "dollars");
	assert.equal(sumOf(json.calls, (call) => call.input_tokens).toString(), String(json.totals.input_tokens));
	assert.equal(sumOf(json.calls, (call) => call.cache_read_tokens).toString(), String(json.totals.cache_read_tokens));
	assert.equal(sumOf(json.calls, (call) => call.output_tokens).toString(), String(json.totals.output_tokens));
	assert.equal(json.calls.length, json.totals.calls);
});

function assertPartsAddUp(parts: any[], totals: any): void {
	assert.ok(sumOf(parts, (part) => part.priced_cost_usd).equals(decimalOf(totals.priced_cost_usd)), `priced dollars of ${JSON.stringify(parts)} against ${totals.priced_cost_usd}`);
	for (const field of ["calls", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "unpriced_calls"]) {
		assert.equal(sumOf(parts, (part) => part[field]).toString(), String(totals[field]), field);
	}
}

Then("the rows of the response add up to its totals", function (this: ChatticusWorld) {
	const json = responseOf(this).json;
	assert.equal(json.next_cursor, null, "the rows are one page");
	assertPartsAddUp(json.rows.map((row: any) => row.totals), json.totals);
	assert.equal(json.rows.length, json.totals.rows);
});

Then("the groups of the response add up to its totals", function (this: ChatticusWorld) {
	const json = responseOf(this).json;
	assert.equal(json.next_cursor, null, "the groups are one page");
	assertPartsAddUp(json.groups.map((group: any) => group.totals), json.totals);
});

Then("the turn rows of the response are newest first", function (this: ChatticusWorld) {
	const rows: any[] = responseOf(this).json.rows;
	for (let index = 1; index < rows.length; index += 1) {
		assert.ok(rows[index - 1].recorded_at >= rows[index].recorded_at, `${rows[index - 1].recorded_at} before ${rows[index].recorded_at}`);
	}
});

Then(
	"paging the turn rows 1 at a time visits all {int} turns once and their costs add up to the total",
	async function (this: ChatticusWorld, expected: number) {
		const headers = await memberHeadersFor(this, TENANT, "pat");
		const seen: string[] = [];
		let total = Decimal.zero();
		let reportedTotal: string | null = null;
		let cursor: string | null = null;
		do {
			await send(this, `/orgs/${TENANT}/costs/turns?limit=1${cursor === null ? "" : `&cursor=${cursor}`}`, headers);
			const json = responseOf(this).json;
			assert.equal(responseOf(this).status, 200, responseOf(this).text);
			assert.ok(json.rows.length <= 1);
			for (const row of json.rows) {
				seen.push(row.id);
				total = total.add(decimalOf(row.totals.priced_cost_usd));
			}
			reportedTotal = json.totals.priced_cost_usd;
			cursor = json.next_cursor;
		} while (cursor !== null);
		assert.equal(seen.length, expected);
		assert.equal(new Set(seen).size, expected);
		assert.ok(total.equals(decimalOf(reportedTotal)));
	},
);

Then("the unpriced row of the response has no dollar total and says it is a gateway call", function (this: ChatticusWorld) {
	const rows: any[] = responseOf(this).json.rows;
	const unpriced = rows.filter((row) => row.totals.unpriced_calls > 0);
	assert.equal(unpriced.length, 1, JSON.stringify(rows));
	assert.equal(unpriced[0].row_kind, "gateway_call");
	assert.equal(unpriced[0].source, "gateway");
	assert.equal(unpriced[0].totals.cost_usd, null);
	assert.equal(unpriced[0].totals.complete, false);
	assert.equal(unpriced[0].totals.priced_cost_usd, "0");
});

Then(
	"the estimated gateway row of the response costs {word} dollars and the session row has source {string}",
	function (this: ChatticusWorld, dollars: string, source: string) {
		const rows: any[] = responseOf(this).json.rows;
		const estimated = rows.filter((row) => row.estimated === true);
		assert.equal(estimated.length, 1, JSON.stringify(rows));
		assert.equal(estimated[0].source, "gateway");
		assert.equal(estimated[0].row_kind, "gateway_call");
		assert.equal(estimated[0].totals.cost_usd, dollars);
		const sessionRows = rows.filter((row) => row.row_kind === "turn");
		assert.equal(sessionRows.length, 1);
		assert.equal(sessionRows[0].source, source);
		assert.equal(sessionRows[0].estimated, false);
	},
);

Then("the response content type is {string}", function (this: ChatticusWorld, contentType: string) {
	assert.equal(responseOf(this).headers.get("Content-Type"), contentType);
});

Then("the response header {string} is {string}", function (this: ChatticusWorld, name: string, value: string) {
	assert.equal(responseOf(this).headers.get(name), value);
});

Then("the response header {string} contains {string}", function (this: ChatticusWorld, name: string, fragment: string) {
	const value = responseOf(this).headers.get(name);
	assert.ok(value !== null && value.includes(fragment), `${name}: ${value}`);
});

function csvRecords(text: string): Array<Record<string, string>> {
	const lines = text.split("\r\n").filter((line) => line !== "");
	const header = lines[0]!.split(",");
	return lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((value, index) => [header[index]!, value])));
}

function exportRecords(world: ChatticusWorld): Array<Record<string, unknown>> {
	const response = responseOf(world);
	const type = response.headers.get("Content-Type") ?? "";
	if (type.startsWith("text/csv")) return csvRecords(response.text);
	return response.text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

Then(
	"the export has {int} data line(s) and its {string} column is {string}",
	function (this: ChatticusWorld, count: number, column: string, value: string) {
		const records = exportRecords(this);
		assert.equal(records.length, count);
		assert.equal(records[0]![column], value);
	},
);

Then(
	"the export has {int} data lines and each has price book {string}",
	function (this: ChatticusWorld, count: number, priceBookId: string) {
		const records = exportRecords(this);
		assert.equal(records.length, count);
		for (const record of records) assert.equal(record.price_book_id, priceBookId);
	},
);

Then("the export line {int} has {string} {string}", function (this: ChatticusWorld, line: number, column: string, value: string) {
	assert.equal(exportRecords(this)[line - 1]![column], value);
});
