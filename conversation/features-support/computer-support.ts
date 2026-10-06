import type { ComputerStartJob, ComputerStartQueue } from "../src/domain/computer-start.ts";
import { DynamoComputerActionStore } from "../src/store/action-store.ts";
import type { ComputerHandoffDependencies } from "../src/turn/park.ts";
import type { ChatticusWorld } from "./world.ts";

/** The queue name computer start jobs are recorded under in the scenario's queue recorder. */
export const COMPUTER_START_QUEUE = "computer-starts";

/** The scenario's ComputerStartJobs queue. */
export const computerStartQueueOf = (world: ChatticusWorld): ComputerStartQueue => ({
	async enqueue(job: ComputerStartJob): Promise<void> {
		world.queues.send(COMPUTER_START_QUEUE, job);
	},
});

/** The scenario's computer action store over its Messaging table. */
export const actionStoreOf = (world: ChatticusWorld): DynamoComputerActionStore =>
	new DynamoComputerActionStore(world.messagingTable.client, world.messagingTable.tableName);

/** What the computer handoff reads and writes in a scenario: its table, its start queue and its budget rollups. */
export const computerHandoffDependenciesFor = (world: ChatticusWorld): ComputerHandoffDependencies => ({
	actions: actionStoreOf(world),
	computerStarts: computerStartQueueOf(world),
	rollups: world.store,
	environment: world.budgetEnvironment,
	heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds,
});
