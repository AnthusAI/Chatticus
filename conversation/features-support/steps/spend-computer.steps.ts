import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { setComputerStopped } from "../../src/domain/computers.ts";
import { SPEND_CEILING_EXCEEDED_REASON, SPEND_CEILING_METER_UNAVAILABLE_REASON } from "../../src/domain/organization-spend.ts";
import { type CapabilityPolicy } from "../../src/policy/capability-policy.ts";
import { recordResponse } from "../api.ts";
import { actionStoreOf } from "../computer-support.ts";
import {
	computerScenarioOf,
	deliverStartJob,
	journalNow,
	queuedStartJobs,
	workTurn,
} from "../computer-scenario.ts";
import { FakeHostStartDriver } from "../fakes/fake-host-start-driver.ts";
import { modelScenarioOf, runBotTurn } from "../executor-harness.ts";
import { bearerFor } from "../front-door.ts";
import {
	ABOVE_CEILING_MONTH_TO_DATE_USD,
	OWNER_EMAIL,
	provisionEnabledOrganizationWithCeiling,
	spendScenario,
	spendToday,
} from "../spend-ceiling.ts";
import { activeTurnOf, ensureMember, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import { grantToPayload } from "../../src/policy/capability-policy.ts";
import { askBot } from "./model-tool-loop-sinks.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const SPEND_BOT = "Researcher";
const SPEND_USER = "sam";
const HOUSEHOLD_BROWSER_ORIGIN = "https://household.example.com";
const HOUSEHOLD_BROWSER_URL = `${HOUSEHOLD_BROWSER_ORIGIN}/browser`;

async function ensureSpendBot(world: ChatticusWorld): Promise<void> {
	const { tenantId } = spendScenario(world);
	await ensureMember(world, tenantId, SPEND_USER);
	world.botsById ??= new Map();
	world.botsByName ??= new Map();
	if (world.botsByName.get(SPEND_BOT) === undefined) {
		const bot = await createBot(tenantId, SPEND_BOT, { creatorUserId: SPEND_USER }, { store: world.messagingStore(), ids: world.ids });
		world.botsById.set(bot.botId, bot);
		world.botsByName.set(SPEND_BOT, bot);
		world.botCreatorUserIds.set(SPEND_BOT, SPEND_USER);
	}
}

Given("the organization computer is stopped", async function (this: ChatticusWorld) {
	const tenantId = this.spendCeilingScenario === null ? "anthus" : spendScenario(this).tenantId;
	await setComputerStopped(tenantId, true, { store: this.messagingStore(), ids: this.ids });
});

Given("an organization whose work is paused at its spend ceiling", async function (this: ChatticusWorld) {
	await provisionEnabledOrganizationWithCeiling(this);
	await spendToday(this, ABOVE_CEILING_MONTH_TO_DATE_USD);
});

Given("a queued computer continuation for workspace file read", async function (this: ChatticusWorld) {
	await ensureSpendBot(this);
	await askBot(this, SPEND_BOT, "read workspace file /workspace/research/notes.txt");
	assert.equal(await workTurn(this, SPEND_BOT), "parked");
	const jobs = queuedStartJobs(this);
	assert.equal(jobs.length, 1);
	computerScenarioOf(this).startJob = jobs[0]!;
});

Given("month-to-date spend has passed the ceiling", async function (this: ChatticusWorld) {
	await spendToday(this, ABOVE_CEILING_MONTH_TO_DATE_USD);
});

When("its owner raises the ceiling above current spend", async function (this: ChatticusWorld) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const response = await recordResponse(
		await this.api.patch(`/orgs/${spendScenario(this).tenantId}/monthly-aws-spend-ceiling`, {
			headers: await bearerFor(this, OWNER_EMAIL),
			body: { monthly_aws_spend_ceiling_usd: "500.00" },
		}),
	);
	assert.equal(response.status, 200, response.text);
});

When("a member asks a bot for work that needs the computer", async function (this: ChatticusWorld) {
	await ensureSpendBot(this);
	await askBot(this, SPEND_BOT, "read workspace file /workspace/research/notes.txt");
	computerScenarioOf(this).lastOutcome = await runBotTurn(this, SPEND_BOT);
});

When("a member asks a bot to open the household browser", async function (this: ChatticusWorld) {
	await ensureSpendBot(this);
	const explicit = (this.capabilityPolicy as CapabilityPolicy | null)?.grant ?? null;
	modelScenarioOf(this).scripted.toolCall("browse", { url: HOUSEHOLD_BROWSER_URL }, "I will open the browser.").reply("The browser is open.");
	await askBot(this, SPEND_BOT, "open the household browser");
	const grant = explicit === null ? { tools: ["browse"], origins: [HOUSEHOLD_BROWSER_ORIGIN], recipients: [], file_scopes: [], egress_classes: ["approved_origin_fetch"], ingest_classes: [] } : grantToPayload(explicit);
	const headers = await memberHeadersFor(this, spendScenario(this).tenantId, SPEND_USER);
	const replaced = await putActiveTurnGrant(this, headers, grant, spendScenario(this).tenantId);
	assert.equal(replaced.status, 200, replaced.text);
	computerScenarioOf(this).lastOutcome = await runBotTurn(this, SPEND_BOT);
});

When("a computer-capable worker pulls the paused spend continuation job", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	state.driver = new FakeHostStartDriver();
	await deliverStartJob(this, state.startJob!, state.driver);
	assert.equal(state.startError, null, state.startError?.message);
});

async function refusalText(world: ChatticusWorld): Promise<string> {
	const state = computerScenarioOf(world);
	if (state.startOutcome !== null) {
		assert.equal(state.startOutcome.kind, "refused");
		return state.startOutcome.reason;
	}
	const results = (await journalNow(world)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, 1, JSON.stringify(results));
	return String(results[0]!.body);
}

Then("the request is refused with a spend ceiling reason", async function (this: ChatticusWorld) {
	const text = await refusalText(this);
	assert.ok(text.includes(SPEND_CEILING_EXCEEDED_REASON), text);
});

Then("the request is refused with a spend meter unavailable reason", async function (this: ChatticusWorld) {
	assert.ok((await refusalText(this)).includes(SPEND_CEILING_METER_UNAVAILABLE_REASON));
});

Then("no computer is started", async function (this: ChatticusWorld) {
	const { tenantId } = spendScenario(this);
	const state = computerScenarioOf(this);
	const driver = state.driver ?? new FakeHostStartDriver();
	state.driver = driver;
	const pendingStartJobs = queuedStartJobs(this);
	assert.deepEqual(pendingStartJobs, [], "a computer start job was queued");
	for (const job of pendingStartJobs) {
		await deliverStartJob(this, job, driver);
	}
	assert.deepEqual(driver.invocations, []);
	assert.equal((await this.messagingStore().getComputer(tenantId))?.hostStartGeneration ?? 0, 0);
	assert.equal((await actionStoreOf(this).listOpen(tenantId)).filter((action) => action.status === "claimed").length, 0);
});

Then("the turn is completed rather than left waiting", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const turn = await this.turnControlStore().getTurn(tenantId, turnId);
	assert.equal(turn?.status, "completed");
	assert.equal(turn?.waitingFor, null);
	assert.deepEqual(await actionStoreOf(this).listForTurn(tenantId, turnId), []);
});

Then("computer work is accepted again", async function (this: ChatticusWorld) {
	assert.equal(computerScenarioOf(this).lastOutcome, "parked");
	const { tenantId, turnId } = activeTurnOf(this);
	assert.equal((await actionStoreOf(this).listForTurn(tenantId, turnId)).length, 1);
});
