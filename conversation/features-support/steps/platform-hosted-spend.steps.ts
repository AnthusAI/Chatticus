import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { addDays, utcDayOf } from "../../src/budget/calendar.ts";
import { Decimal } from "../../src/budget/decimal.ts";
import { setMonthlyAwsSpendCeiling } from "../../src/domain/organization-spend.ts";
import { provisionEnabledOrganizationWithCeiling, rollUpDay, spendScenario } from "../spend-ceiling.ts";
import type { ChatticusWorld } from "../world.ts";

const SECONDS_PER_HOUR = 3600;
const SHORT_RUN_START_TIME = "12:00:00Z";
const nextGenerationByTenant = new WeakMap<ChatticusWorld, Map<string, number>>();

function nextGeneration(world: ChatticusWorld, tenantId: string): number {
	const counters = nextGenerationByTenant.get(world) ?? new Map<string, number>();
	nextGenerationByTenant.set(world, counters);
	const generation = (counters.get(tenantId) ?? 0) + 1;
	counters.set(tenantId, generation);
	return generation;
}

async function recordRun(world: ChatticusWorld, tenantId: string, startedAt: Date, lastSeenAt: Date): Promise<void> {
	await world.messagingTable.putComputerRuntimeSegment({
		tenantId,
		ownerGeneration: nextGeneration(world, tenantId),
		startedAt,
		lastSeenAt,
	});
}

function yesterdayOf(world: ChatticusWorld): string {
	return addDays(utcDayOf(world.clock.now()), -1);
}

Given(
	"the computer of tenant {string} ran for {int} hour(s) on {word}",
	async function (this: ChatticusWorld, tenantId: string, hours: number, day: string) {
		const startedAt = new Date(`${day}T00:00:00Z`);
		await recordRun(this, tenantId, startedAt, new Date(startedAt.getTime() + hours * SECONDS_PER_HOUR * 1000));
	},
);

Given(
	"the computer of tenant {string} ran for {int} seconds on {word}",
	async function (this: ChatticusWorld, tenantId: string, seconds: number, day: string) {
		const startedAt = new Date(`${day}T${SHORT_RUN_START_TIME}`);
		await recordRun(this, tenantId, startedAt, new Date(startedAt.getTime() + seconds * 1000));
	},
);

Given(
	"the computer of tenant {string} ran from {word} to {word}",
	async function (this: ChatticusWorld, tenantId: string, start: string, end: string) {
		await recordRun(this, tenantId, new Date(start), new Date(end));
	},
);

Given(
	"the runtime records of the computer of tenant {string} are unreadable",
	async function (this: ChatticusWorld, tenantId: string) {
		await this.messagingTable.putUnreadableComputerRuntimeSegment(tenantId);
	},
);

When(
	"the runtime records of the computer of tenant {string} are readable again",
	async function (this: ChatticusWorld, tenantId: string) {
		await this.messagingTable.deleteUnreadableComputerRuntimeSegment(tenantId);
	},
);

Given(
	"an enabled organization with a monthly spend ceiling of {string} USD",
	async function (this: ChatticusWorld, ceiling: string) {
		await provisionEnabledOrganizationWithCeiling(this);
		const state = spendScenario(this);
		await setMonthlyAwsSpendCeiling(state.tenantId, state.ownerUserId, Decimal.parse(ceiling), {
			store: this.messagingStore(),
		});
	},
);

Given("its computer ran for {int} hours yesterday", async function (this: ChatticusWorld, hours: number) {
	const startedAt = new Date(`${yesterdayOf(this)}T00:00:00Z`);
	await recordRun(this, spendScenario(this).tenantId, startedAt, new Date(startedAt.getTime() + hours * SECONDS_PER_HOUR * 1000));
});

Given("its computer runtime records are unreadable", async function (this: ChatticusWorld) {
	await this.messagingTable.putUnreadableComputerRuntimeSegment(spendScenario(this).tenantId);
});

Given("the daily rollup has run for yesterday", async function (this: ChatticusWorld) {
	await rollUpDay(this, yesterdayOf(this));
});

Then(
	"the control plane records that the owner of generation {int} ran for {int} seconds",
	async function (this: ChatticusWorld, generation: number, seconds: number) {
		const segments = await this.messagingStore().listComputerRuntimeSegments("anthus");
		const segment = segments.find((candidate) => candidate.ownerGeneration === generation);
		assert.ok(segment, `no runtime record for generation ${generation}`);
		assert.equal((segment.lastSeenAt.getTime() - segment.startedAt.getTime()) / 1000, seconds);
	},
);
