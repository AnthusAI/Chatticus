import assert from "node:assert/strict";
import type { ChatticusWorld } from "./world.ts";
import type { KanbusBoardProcess } from "./web-kanbus-board-process.ts";

/** The board process of each running scenario, shared by every step file that drives the Board tab. */
export const kanbusBoardScenarios = new WeakMap<ChatticusWorld, KanbusBoardProcess>();

/** The board process of the scenario that is running, or a failure when none was started. */
export function kanbusBoardProcessOf(world: ChatticusWorld): KanbusBoardProcess {
	const found = kanbusBoardScenarios.get(world);
	assert.ok(found, "No board scenario is running.");
	return found;
}
