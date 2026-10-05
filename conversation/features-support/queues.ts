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
			enqueuedAt: new Date(),
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
