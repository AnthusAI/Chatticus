/**
 * HTTP client for thin-turn conversation over the Front Door.
 *
 * Provides methods to interact with the Chatticus API for messaging,
 * SSE streaming, and turn management.
 */

import { parseSseFrames, type SseFrame } from "./sse-parser.ts";

export interface HttpClientOptions {
	baseUrl: string;
	headers?: Record<string, string>;
	timeout?: number;
}

export interface TurnWatchOutcome {
	events: Array<Record<string, unknown>>;
	tokens: string[];
	committedBody: string | null;
	lastSeq: number;
}

/**
 * Wraps fetch for thin-turn API interaction with SSE streaming.
 */
export class HttpClient {
	private baseUrl: string;
	private headers: Record<string, string>;
	private timeout: number;

	constructor(options: HttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.headers = options.headers || {};
		this.timeout = options.timeout ?? 120000;
	}

	async get(path: string, init?: RequestInit): Promise<Response> {
		const url = this.resolvePath(path);
		return fetch(url, {
			method: "GET",
			signal: AbortSignal.timeout(this.timeout),
			...init,
			headers: { ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
		});
	}

	async post(path: string, body?: unknown, init?: RequestInit): Promise<Response> {
		const url = this.resolvePath(path);
		const headers: Record<string, string> = { ...this.headers };
		let bodyStr: string | undefined;

		if (body) {
			headers["content-type"] = "application/json";
			bodyStr = JSON.stringify(body);
		}

		return fetch(url, {
			method: "POST",
			headers,
			body: bodyStr,
			signal: AbortSignal.timeout(this.timeout),
			...init,
		});
	}

	async stream(path: string, init?: RequestInit): Promise<Response> {
		const url = this.resolvePath(path);
		return fetch(url, {
			method: "GET",
			signal: AbortSignal.timeout(this.timeout),
			...init,
			headers: { ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
		});
	}

	private resolvePath(path: string): string {
		if (this.baseUrl.endsWith("/api")) {
			return `${this.baseUrl.slice(0, -4)}${path}`;
		}
		return `${this.baseUrl}${path}`;
	}

	async streamTurnEvents(
		turnId: string,
		organizationPathOrAfterSeq?: string | number,
		onEvent?: (event: Record<string, unknown>) => void,
		stopAfterTokenCount?: number,
		timeout: number = 120,
		afterSeq?: number,
	): Promise<TurnWatchOutcome> {
		// Support both old and new calling conventions
		let orgPath = "/orgs/anthus";
		let actualAfterSeq = afterSeq;

		if (typeof organizationPathOrAfterSeq === "string") {
			orgPath = organizationPathOrAfterSeq;
		} else if (typeof organizationPathOrAfterSeq === "number") {
			actualAfterSeq = organizationPathOrAfterSeq;
		}

		const outcome: TurnWatchOutcome = {
			events: [],
			tokens: [],
			committedBody: null,
			lastSeq: 0,
		};

		const headers: Record<string, string> = {};
		if (actualAfterSeq) {
			headers["last-event-id"] = String(actualAfterSeq);
		}

		const path = `${orgPath}/turns/${turnId}/stream`;
		const response = await this.stream(path, { headers });

		if (!response.ok) {
			throw new Error(`stream failed ${response.status}: ${await response.text()}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("No response body");
		}

		const decoder = new TextDecoder();
		let carry = "";
		let tokenCount = 0;
		const deadline = Date.now() + timeout * 1000;

		try {
			while (true) {
				if (Date.now() > deadline) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				const { frames, carry: newCarry } = parseSseFrames(chunk, carry);
				carry = newCarry;

				for (const frame of frames) {
					let event: Record<string, unknown>;
					try {
						event = JSON.parse(frame.data);
					} catch {
						continue;
					}

					outcome.events.push(event);
					outcome.lastSeq = Math.max(outcome.lastSeq, Number(event.seq) || 0);

					if (onEvent) {
						onEvent(event);
					}

					if (event.kind === "turn.token" && event.token) {
						outcome.tokens.push(String(event.token));
						tokenCount++;
						if (stopAfterTokenCount && tokenCount >= stopAfterTokenCount) {
							reader.cancel();
							return outcome;
						}
					}

					if (
						event.kind === "turn.completed" ||
						event.kind === "turn.failed" ||
						event.kind === "turn.reconciling"
					) {
						if (event.kind === "turn.completed" && event.body) {
							outcome.committedBody = String(event.body);
						}
						reader.cancel();
						return outcome;
					}
				}
			}
		} finally {
			reader.cancel();
		}

		return outcome;
	}

	async streamTurnEventsUntilToken(turnId: string, stopAfterTokenCount: number): Promise<TurnWatchOutcome> {
		return this.streamTurnEvents(turnId, "/orgs/anthus", undefined, stopAfterTokenCount, 5, undefined);
	}
}
