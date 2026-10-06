import assert from "node:assert/strict";
import { parseSseFrames, type SseFrame } from "../src/acceptance/sse-parser.ts";
import { memberGet } from "./org-user-client.ts";
import type { ChatticusWorld } from "./world.ts";

/** One turn event as a watcher saw it on the wire. */
export type WatchedEvent = { readonly kind: string; readonly seq: number; readonly payload: Record<string, any> };

/** A member watching one turn through the server-sent event route, reading in the background until the stream ends. */
export class TurnWatcher {
	readonly events: WatchedEvent[] = [];
	readonly frames: SseFrame[] = [];
	readonly finished: Promise<void>;

	private constructor(response: Response) {
		assert.equal(response.status, 200, `The stream answered ${response.status}`);
		assert.ok(response.body, "The stream has no body");
		this.finished = this.read(response.body.getReader());
	}

	/** Open the stream of a turn as an enabled member of its organization. */
	static async open(world: ChatticusWorld, tenantId: string, turnId: string): Promise<TurnWatcher> {
		return new TurnWatcher(await memberGet(world, `/orgs/${tenantId}/turns/${turnId}/stream`));
	}

	private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let carry = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			const parsed = parseSseFrames(decoder.decode(chunk.value, { stream: true }), carry);
			carry = parsed.carry;
			for (const frame of parsed.frames) {
				if (frame.data === "") continue;
				this.frames.push(frame);
				const payload = JSON.parse(frame.data) as Record<string, any>;
				this.events.push({ kind: frame.event, seq: Number(frame.id), payload });
			}
		}
	}

	/** Wait for the stream to end, which it does after a terminal event. */
	async untilClosed(): Promise<void> {
		await Promise.race([
			this.finished,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("The stream did not close.")), 10_000)),
		]);
	}
}
