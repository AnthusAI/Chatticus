import assert from "node:assert/strict";
import { parseSseFrames, type SseFrame } from "../src/acceptance/sse-parser.ts";
import { httpBaseUrl } from "./front-door.ts";
import { memberGet, organizationMemberHeaders } from "./org-user-client.ts";
import type { ChatticusWorld } from "./world.ts";

/** One turn event as a watcher saw it on the wire. */
export type WatchedEvent = { readonly kind: string; readonly seq: number; readonly payload: Record<string, any> };

/** How a watcher reaches the stream. */
export type WatchOptions = {
	/** The Last-Event-ID to send, as the browser does when it reconnects. */
	readonly lastEventId?: string;
	/** Read through a real HTTP request to a loopback server instead of calling the application in process. */
	readonly overHttp?: boolean;
};

const FAILURE_TIMEOUT_MILLISECONDS = 30_000;

/** A member watching one turn through the server-sent event route, reading in the background until the stream ends. */
export class TurnWatcher {
	readonly events: WatchedEvent[] = [];
	readonly frames: SseFrame[] = [];
	readonly finished: Promise<void>;
	rawText = "";
	closed = false;

	/** Settles when the stream has ended; unlike `untilClosed` it holds no timer, so it can be raced. */
	readonly closedSignal: Promise<void>;

	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private markClosed: () => void = () => undefined;
	private readonly listeners = new Set<() => void>();

	private constructor(response: Response) {
		assert.ok(response.body, "The stream has no body");
		this.reader = response.body.getReader();
		this.closedSignal = new Promise<void>((resolve) => {
			this.markClosed = resolve;
		});
		this.finished = this.read();
	}

	/** Open the stream of a turn as an enabled member of its organization. */
	static async open(world: ChatticusWorld, tenantId: string, turnId: string, options: WatchOptions = {}): Promise<TurnWatcher> {
		const response = await TurnWatcher.request(world, tenantId, turnId, options);
		assert.equal(response.status, 200, `The stream answered ${response.status}`);
		return new TurnWatcher(response);
	}

	/** Ask for the stream and return the raw response, whatever its status. */
	static async request(world: ChatticusWorld, tenantId: string, turnId: string, options: WatchOptions = {}): Promise<Response> {
		const path = `/orgs/${tenantId}/turns/${turnId}/stream`;
		const headers: Record<string, string> = { ...(await organizationMemberHeaders(world, path)) };
		if (options.lastEventId !== undefined) {
			headers["Last-Event-ID"] = options.lastEventId;
		}
		if (options.overHttp) {
			return fetch(`${await httpBaseUrl(world)}${path}`, { headers });
		}
		assert.ok(world.api, "The scenario has no HTTP front door.");
		if (options.lastEventId === undefined) {
			return memberGet(world, path);
		}
		return world.api.get(path, { headers });
	}

	private async read(): Promise<void> {
		const decoder = new TextDecoder();
		let carry = "";
		try {
			for (;;) {
				const chunk = await this.reader.read();
				if (chunk.done) return;
				const text = decoder.decode(chunk.value, { stream: true });
				this.rawText += text;
				const parsed = parseSseFrames(text, carry);
				carry = parsed.carry;
				for (const frame of parsed.frames) {
					if (frame.data === "") continue;
					this.frames.push(frame);
					this.events.push({ kind: frame.event, seq: Number(frame.id), payload: JSON.parse(frame.data) as Record<string, any> });
				}
				this.notify();
			}
		} catch {
			return;
		} finally {
			this.closed = true;
			this.markClosed();
			this.notify();
		}
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}

	/** The heartbeat comment frames received so far. */
	get heartbeats(): number {
		return this.rawText.split(": heartbeat\n\n").length - 1;
	}

	/** Wait until the condition holds over what the watcher has received, failing after a generous bound. */
	async until(condition: () => boolean, description: string): Promise<void> {
		if (condition()) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(check);
				reject(new Error(`Timed out waiting for ${description}; received ${JSON.stringify(this.rawText)}`));
			}, FAILURE_TIMEOUT_MILLISECONDS);
			const check = (): void => {
				if (!condition()) return;
				clearTimeout(timer);
				this.listeners.delete(check);
				resolve();
			};
			this.listeners.add(check);
		});
	}

	/** Wait for the stream to end, which it does after a terminal event or when the server ends it. */
	async untilClosed(): Promise<void> {
		await this.until(() => this.closed, "the stream to close");
	}

	/** Drop the connection the way a closing browser tab does. */
	async disconnect(): Promise<void> {
		await this.reader.cancel().catch(() => undefined);
		await this.finished;
	}
}
