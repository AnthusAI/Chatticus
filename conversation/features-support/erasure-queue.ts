import type { ErasureQueue, ErasureQueueMessage } from "../src/turn/sqs-queues.ts";
import type { ChatticusWorld } from "./world.ts";

/** An erasure queue that keeps what was sent to it, so a scenario can see it and hand it to the erasure worker. */
export class RecordingErasureQueue implements ErasureQueue {
	readonly messages: ErasureQueueMessage[] = [];

	async send(message: ErasureQueueMessage): Promise<void> {
		this.messages.push(message);
	}
}

const queues = new WeakMap<ChatticusWorld, RecordingErasureQueue>();

/** The scenario's erasure queue, created on first use. */
export function erasureQueueOf(world: ChatticusWorld): RecordingErasureQueue {
	let queue = queues.get(world);
	if (queue === undefined) {
		queue = new RecordingErasureQueue();
		queues.set(world, queue);
	}
	return queue;
}
