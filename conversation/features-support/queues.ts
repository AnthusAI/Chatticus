import type { Clock } from "./clock.ts";

/**
 * A message stored in an in-process queue recorder.
 */
export interface QueuedMessage {
	readonly body: unknown;
	readonly delaySeconds?: number;
	readonly enqueuedAt: Date;
}

/**
 * In-process queue recorder for testing. Records messages sent to queues and
 * allows draining them with a handler function.
 */
export class QueueRecorder {
	private queues: Map<string, QueuedMessage[]> = new Map();
	private clock: Clock;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	/**
	 * Record a message sent to a queue.
	 *
	 * @param queue Queue name.
	 * @param body Message body.
	 * @param delaySeconds Optional delay in seconds.
	 */
	send(queue: string, body: unknown, delaySeconds?: number): void {
		if (!this.queues.has(queue)) {
			this.queues.set(queue, []);
		}
		this.queues.get(queue)!.push({
			body,
			delaySeconds,
			enqueuedAt: this.clock.now(),
		});
	}

	/**
	 * Get all pending messages for a queue without removing them.
	 *
	 * @param queue Queue name.
	 * @returns Array of queued messages.
	 */
	pending(queue: string): QueuedMessage[] {
		return [...(this.queues.get(queue) ?? [])];
	}

	/**
	 * Remove and return the first pending message of a queue that satisfies a predicate.
	 *
	 * @param queue Queue name.
	 * @param predicate Whether a message body is the one wanted.
	 * @returns The message, or null when none matches.
	 */
	take(queue: string, predicate: (body: unknown) => boolean): QueuedMessage | null {
		const messages = this.queues.get(queue) ?? [];
		const index = messages.findIndex((message) => predicate(message.body));
		if (index < 0) {
			return null;
		}
		return messages.splice(index, 1)[0]!;
	}

	/**
	 * Remove and return the first message of a queue whose delay has run out on the fake clock, as a delay queue would
	 * deliver it.
	 *
	 * @param queue Queue name.
	 * @returns The message, or null when none is due yet.
	 */
	takeDue(queue: string): QueuedMessage | null {
		const now = this.clock.now().getTime();
		const messages = this.queues.get(queue) ?? [];
		const index = messages.findIndex((message) => message.enqueuedAt.getTime() + (message.delaySeconds ?? 0) * 1000 <= now);
		if (index < 0) {
			return null;
		}
		return messages.splice(index, 1)[0]!;
	}

	/**
	 * Drain a queue by processing all messages with a handler function.
	 * Messages are removed from the queue as they are processed.
	 *
	 * @param queue Queue name.
	 * @param handler Function to handle each message.
	 */
	async drain(queue: string, handler: (m: QueuedMessage) => Promise<void>): Promise<void> {
		const messages = this.queues.get(queue) ?? [];
		while (messages.length > 0) {
			const message = messages.shift()!;
			await handler(message);
		}
	}
}
