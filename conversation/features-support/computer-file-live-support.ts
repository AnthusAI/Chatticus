import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LiveFileOutcome, OwnerFileRequest } from "@chatticus/host-protocol/live-files";
import type { FileWaitPort } from "../src/domain/live-files.ts";
import { fileRoutesOf, type FileRouteResponse } from "./computer-snapshot-files-support.ts";
import { FakeLiveDisk } from "./fakes/fake-live-disk.ts";
import type { ChatticusWorld } from "./world.ts";

/** What a step needs to say about a request to a file route. */
export type FileRouteCall = {
	readonly method: "GET" | "PUT" | "POST" | "DELETE";
	readonly path: string;
	readonly headers: Record<string, string>;
	readonly body?: unknown;
};

/**
 * The sleep of the Front Door's wait for the owner, driven by the scenario. A request that waits on the owner parks here
 * instead of sleeping; the scenario's steps let the owner act while it is parked and, to say that the owner stays silent,
 * move the clock a quarter of a second at a time until the request gives up. No scenario waits for real time.
 */
export class ScenarioFileWait implements FileWaitPort {
	private parked: Array<() => void> = [];
	private listeners: Array<() => void> = [];
	/** How many times the Front Door has gone to sleep waiting for an owner in this scenario. */
	sleepCount = 0;

	sleep(_milliseconds: number): Promise<void> {
		return new Promise((resolve) => {
			this.sleepCount += 1;
			this.parked.push(resolve);
			for (const listener of this.listeners.splice(0)) listener();
		});
	}

	/** Resolve with the value of `pending` once it settles, or with `parked` when the request is waiting for the owner. */
	async untilSettledOrParked<Value>(pending: Promise<Value>): Promise<{ settled: true; value: Value } | { settled: false }> {
		if (this.parked.length > 0) return { settled: false };
		const parkedSignal = new Promise<{ settled: false }>((resolve) => this.listeners.push(() => resolve({ settled: false })));
		return Promise.race([pending.then((value) => ({ settled: true as const, value })), parkedSignal]);
	}

	/** Let every parked request look again. */
	release(): void {
		for (const resolve of this.parked.splice(0)) resolve();
	}
}

/** What a scenario about the member file routes remembers between its steps. */
export type MemberFilesScenario = {
	readonly disk: FakeLiveDisk;
	readonly wait: ScenarioFileWait;
	/** Every response of the scenario's file routes, in order. */
	readonly responses: FileRouteResponse[];
	/** The request that is waiting for the owner, with the member and the route it was made as. */
	pending: Promise<FileRouteResponse> | null;
	/** The sleeps the last request made before it was answered. */
	sleepsOfLastRequest: number;
	/** The hash a member holds for a file, by member and path. */
	readonly heldHashes: Map<string, string>;
	/** The request the fake owner took and kept without answering. */
	heldRequest: OwnerFileRequest | null;
	/** The last answer the fake owner posted, and the request it answered. */
	lastAnswer: { operationId: string; outcome: LiveFileOutcome } | null;
	/** What the owner was told when it posted an answer, as the last step left it. */
	lastOwnerReply: { status: number; body: any } | null;
	/** The manifest checksum of the last publish, to prove the pack did not change. */
	packChecksumBefore: string | null;
	/** The computer record as it was before a step that must not change it. */
	computerRecordBefore: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, MemberFilesScenario>();

/** The scenario's member file state, created on first use. */
export function memberFilesOf(world: ChatticusWorld): MemberFilesScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			disk: new FakeLiveDisk(),
			wait: new ScenarioFileWait(),
			responses: [],
			pending: null,
			sleepsOfLastRequest: 0,
			heldHashes: new Map(),
			heldRequest: null,
			lastAnswer: null,
			lastOwnerReply: null,
			packChecksumBefore: null,
			computerRecordBefore: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The wait the Front Door of this scenario sleeps on. */
export const fileWaitOf = (world: ChatticusWorld): ScenarioFileWait => memberFilesOf(world).wait;

/** The SHA-256 of text. */
export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Resolve a table cell or a step argument: `the hash of "x"` is the hash of x. */
export function resolveValue(cell: string): string {
	const match = /^the hash of "(.*)"$/.exec(cell);
	return match === null ? cell : hashOf(match[1]!);
}

export async function readRouteResponse(response: Response): Promise<FileRouteResponse> {
	const text = await response.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, text, json, headers: response.headers };
}

function recordResponse(world: ChatticusWorld, response: FileRouteResponse): FileRouteResponse {
	fileRoutesOf(world).response = response;
	memberFilesOf(world).responses.push(response);
	return response;
}

/**
 * Send one request to a file route through the scenario's front door. A request answered at once is recorded as the
 * scenario's file response. A request that waits for the owner is left in flight and recorded when a step lets the owner
 * answer ({@link settleInFlight}).
 *
 * @returns The response, or null while the request waits for the owner.
 */
export async function sendFileRoute(world: ChatticusWorld, call: FileRouteCall): Promise<FileRouteResponse | null> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const scenario = memberFilesOf(world);
	assert.equal(scenario.pending, null, "An earlier file request is still waiting for the owner.");
	const sleepsBefore = scenario.wait.sleepCount;
	const options = { headers: call.headers, ...(call.body === undefined ? {} : { body: call.body }) };
	const started =
		call.method === "GET"
			? world.api.get(call.path, options)
			: call.method === "PUT"
				? world.api.put(call.path, options)
				: call.method === "DELETE"
					? world.api.delete(call.path, options)
					: world.api.post(call.path, options);
	const pending = started.then(readRouteResponse);
	const first = await scenario.wait.untilSettledOrParked(pending);
	if (first.settled) {
		scenario.sleepsOfLastRequest = scenario.wait.sleepCount - sleepsBefore;
		return recordResponse(world, first.value);
	}
	scenario.pending = pending;
	scenario.sleepsOfLastRequest = scenario.wait.sleepCount - sleepsBefore;
	return null;
}

/**
 * Let the request that waits for the owner finish.
 *
 * @param world The scenario.
 * @param advanceSeconds How far to move the clock each time the request looks again; zero to let it look without time passing,
 *   a quarter of a second to say the owner stays silent.
 * @returns The response, which is now the scenario's file response.
 */
export async function settleInFlight(world: ChatticusWorld, advanceSeconds: number): Promise<FileRouteResponse> {
	const scenario = memberFilesOf(world);
	const pending = scenario.pending;
	assert.ok(pending, "No file request is waiting for the owner.");
	for (let looks = 0; looks < 400; looks += 1) {
		const next = await scenario.wait.untilSettledOrParked(pending);
		if (next.settled) {
			scenario.pending = null;
			return recordResponse(world, next.value);
		}
		if (advanceSeconds > 0) world.clock.advanceSeconds(advanceSeconds);
		scenario.wait.release();
	}
	throw new Error("The file request never finished.");
}

/** Wait until the request in flight has queued itself for the owner, which is when it first goes to sleep. */
export async function untilRequestIsWaiting(world: ChatticusWorld): Promise<void> {
	const scenario = memberFilesOf(world);
	assert.ok(scenario.pending, "No file request is waiting for the owner.");
	const next = await scenario.wait.untilSettledOrParked(scenario.pending);
	if (next.settled) {
		scenario.pending = null;
		recordResponse(world, next.value);
		assert.fail("The file request was answered without waiting for the owner.");
	}
}
