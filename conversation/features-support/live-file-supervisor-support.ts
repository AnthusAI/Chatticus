import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { LiveFileOutcome, OwnerFileRequest } from "@chatticus/host-protocol/live-files";
import { treeHashOf, type LiveTreeDescendant } from "@chatticus/host-protocol/live-file-rules";
import type { OwnerPollResponse } from "@chatticus/host-protocol/supervisor";
import { startIdleSupervisor, supervisorScenarioOf } from "./owner-supervisor-support.ts";
import type { ChatticusWorld } from "./world.ts";

const REAL_WAIT_STEP_MILLISECONDS = 20;
const REAL_WAIT_LIMIT_MILLISECONDS = 15_000;

/** What a file request scenario remembers between its steps. */
export type LiveFileScenario = {
	operationCount: number;
	lastOperationId: string | null;
	readonly issuedAtRealMilliseconds: Map<string, number>;
	readonly observedAfterRealMilliseconds: Map<string, number>;
	/** Named points in fake time or in the log that a later step compares against. */
	readonly marks: Map<string, number>;
};

const scenarios = new WeakMap<ChatticusWorld, LiveFileScenario>();

/** The scenario's file request state, created on first use. */
export function liveFileScenarioOf(world: ChatticusWorld): LiveFileScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { operationCount: 0, lastOperationId: null, issuedAtRealMilliseconds: new Map(), observedAfterRealMilliseconds: new Map(), marks: new Map() };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The SHA-256 of text, as the control plane hashes a file's content. */
export const sha256OfText = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Start the supervisor if no step has started it yet, and require that it reached idle. */
export async function ensureIdleSupervisor(world: ChatticusWorld): Promise<void> {
	if (supervisorScenarioOf(world).supervisor === null) await startIdleSupervisor(world);
}

/** A request without the parts every request shares. */
export type FileRequestSpec =
	| { readonly kind: "list" }
	| { readonly kind: "stat"; readonly hash: boolean }
	| { readonly kind: "read" }
	| { readonly kind: "write"; readonly content: string; readonly precondition: { readonly type: "if_match"; readonly sha256: string } | { readonly type: "if_none_match" } }
	| { readonly kind: "delete"; readonly recursive: boolean; readonly precondition: { readonly type: "if_match"; readonly sha256: string } }
	| { readonly kind: "move"; readonly to: string; readonly precondition: { readonly type: "if_match"; readonly sha256: string } }
	| { readonly kind: "mkdir" };

function requestOf(world: ChatticusWorld, path: string, spec: FileRequestSpec, expiresInMilliseconds: number): OwnerFileRequest {
	const scenario = liveFileScenarioOf(world);
	scenario.operationCount += 1;
	const base = { operation_id: `file-operation-${scenario.operationCount}`, path, expires_in_ms: expiresInMilliseconds };
	switch (spec.kind) {
		case "list":
			return { ...base, kind: "list", max_entries: 2000 };
		case "stat":
			return { ...base, kind: "stat", hash: spec.hash };
		case "read":
			return { ...base, kind: "read", offset: 0, length: 262144, mask: true };
		case "write":
			return { ...base, kind: "write", content: spec.content, precondition: spec.precondition };
		case "delete":
			return { ...base, kind: "delete", recursive: spec.recursive, precondition: spec.precondition };
		case "move":
			return { ...base, kind: "move", to: spec.to, precondition: spec.precondition };
		case "mkdir":
			return { ...base, kind: "mkdir" };
	}
}

/**
 * Have the control plane answer the supervisor's next poll with one file request, and let that poll happen.
 *
 * @returns The operation id of the request.
 */
export async function offerFileRequest(world: ChatticusWorld, path: string, spec: FileRequestSpec, expiresInMilliseconds: number = 8000): Promise<string> {
	await ensureIdleSupervisor(world);
	const scenario = supervisorScenarioOf(world);
	const request = requestOf(world, path, spec, expiresInMilliseconds);
	const answer: OwnerPollResponse = { dispatches: [], file_requests: [request], drain: false, next_poll_ms: 1000 };
	scenario.plane.pollScript.push(answer);
	const live = liveFileScenarioOf(world);
	live.lastOperationId = request.operation_id;
	live.issuedAtRealMilliseconds.set(request.operation_id, Date.now());
	await scenario.clock.advance(1000);
	return request.operation_id;
}

/** The outcome the supervisor posted for the request, if it has posted one yet. */
export function postedOutcomeOf(world: ChatticusWorld, operationId: string): LiveFileOutcome | null {
	return supervisorScenarioOf(world).plane.fileResults.find((recorded) => recorded.request.operation_id === operationId)?.request.outcome ?? null;
}

/**
 * Wait, in real time while letting the fake clock settle, until the supervisor has posted the answer to the request.
 * A scenario with a real helper process needs real time; a scenario with fake time has moved the clock already.
 */
export async function awaitOutcome(world: ChatticusWorld, operationId: string): Promise<LiveFileOutcome> {
	const scenario = supervisorScenarioOf(world);
	const startedAt = Date.now();
	for (;;) {
		const outcome = postedOutcomeOf(world, operationId);
		if (outcome !== null) {
			liveFileScenarioOf(world).observedAfterRealMilliseconds.set(operationId, Date.now() - (liveFileScenarioOf(world).issuedAtRealMilliseconds.get(operationId) ?? startedAt));
			return outcome;
		}
		assert.ok(Date.now() - startedAt < REAL_WAIT_LIMIT_MILLISECONDS, `The supervisor posted no answer for ${operationId}. Log: ${scenario.logs.join(" | ")}`);
		await new Promise<void>((resolve) => setTimeout(resolve, REAL_WAIT_STEP_MILLISECONDS));
		await scenario.clock.settle();
	}
}

/** The outcome of the most recent request, waiting for it if it is still being worked on. */
export async function lastOutcomeOf(world: ChatticusWorld): Promise<LiveFileOutcome> {
	const id = liveFileScenarioOf(world).lastOperationId;
	assert.ok(id, "No file request was made in this scenario.");
	return awaitOutcome(world, id);
}

/** The tree hash of a real directory, computed by walking it here and not by the helper. */
export function treeHashOfDirectory(directory: string): string {
	const descendants: LiveTreeDescendant[] = [];
	const walk = (current: string, prefix: string): void => {
		for (const name of readdirSync(current)) {
			const full = join(current, name);
			const relativePath = prefix === "" ? name : `${prefix}/${name}`;
			const stats = lstatSync(full);
			if (stats.isDirectory()) {
				descendants.push({ relativePath, kind: "dir" });
				walk(full, relativePath);
			} else if (stats.isSymbolicLink()) descendants.push({ relativePath, kind: "symlink", target: readlinkSync(full) });
			else descendants.push({ relativePath, kind: "file", size: stats.size });
		}
	};
	walk(directory, "");
	return treeHashOf(descendants, (bytes) => createHash("sha256").update(bytes).digest("hex"));
}

/**
 * Let time pass a second at a time, with a moment of real time between seconds so the helper's real file operations can
 * finish, until the condition holds or the fake seconds are used up.
 *
 * @returns Whether the condition held.
 */
export async function advanceUntil(world: ChatticusWorld, condition: () => boolean, maximumSeconds: number): Promise<boolean> {
	const scenario = supervisorScenarioOf(world);
	for (let second = 0; second <= maximumSeconds; second += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 15));
		await scenario.clock.settle();
		if (condition()) return true;
		await scenario.clock.advance(1000);
	}
	return condition();
}
