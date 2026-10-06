import type { AgentEvent } from "@earendil-works/pi-durable";
import { appendTurnEvent, type TurnDependencies, type TurnEventDraft } from "../domain/turns.ts";
import type { TokenCoalescer } from "./coalescer.ts";

const TOOL_RESULT_BODY_LIMIT = 500;

/**
 * Appends one attempt's turn events to the Messaging table strictly one after another. A failed append (a stale
 * attempt, a finished turn, a storage error) is remembered and later appends are dropped, so the executor can look at
 * `failure` between steps instead of having the Pi event listener throw.
 */
export class TurnEventWriter {
	private readonly deps: TurnDependencies;
	private readonly tenantId: string;
	private readonly turnId: string;
	private readonly attemptId: string;
	private chain: Promise<void> = Promise.resolve();
	private firstFailure: unknown = null;

	/**
	 * @param deps Store, clock and identifiers.
	 * @param tenantId Organization.
	 * @param turnId Turn.
	 * @param attemptId The attempt whose fence every append carries.
	 */
	constructor(deps: TurnDependencies, tenantId: string, turnId: string, attemptId: string) {
		this.deps = deps;
		this.tenantId = tenantId;
		this.turnId = turnId;
		this.attemptId = attemptId;
	}

	/** The first error an append raised, or null. */
	get failure(): unknown {
		return this.firstFailure;
	}

	/** Raise the first append failure, if any. */
	throwIfFailed(): void {
		if (this.firstFailure !== null) throw this.firstFailure;
	}

	/** Queue one event; resolves when it has been appended or dropped. */
	write(draft: TurnEventDraft): Promise<void> {
		this.chain = this.chain.then(async () => {
			if (this.firstFailure !== null) return;
			try {
				await appendTurnEvent(this.deps, this.tenantId, this.turnId, this.attemptId, draft);
			} catch (error) {
				this.firstFailure = error;
			}
		});
		return this.chain;
	}

	/** Resolve when every queued event has been appended or dropped. */
	idle(): Promise<void> {
		return this.chain;
	}
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
};

/** What the executor learns from the Pi event listener besides the events it writes. */
export class AgentEventDelivery {
	private readonly settled = new Set<number>();
	private readonly waiters = new Map<number, Array<() => void>>();

	/** Record that a batch containing the settlement of a submission has been fully handled. */
	noteSettled(submissionId: number): void {
		this.settled.add(submissionId);
		for (const resolve of this.waiters.get(submissionId) ?? []) resolve();
		this.waiters.delete(submissionId);
	}

	/**
	 * Wait until the listener has handled the batch that settled a submission. Pi delivers batches after the commit that
	 * settled the submission, so a caller about to end the turn waits here to keep every streamed token ahead of the
	 * terminal event. An overflowing stream replaces batches with a snapshot and never delivers the settlement, so the
	 * wait is bounded.
	 *
	 * @param submissionId The submission.
	 * @param timeoutMilliseconds The longest to wait.
	 */
	async untilSettled(submissionId: number, timeoutMilliseconds: number): Promise<void> {
		if (this.settled.has(submissionId)) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMilliseconds);
			const waiting = this.waiters.get(submissionId) ?? [];
			waiting.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.waiters.set(submissionId, waiting);
		});
	}
}

/**
 * The listener that turns Pi's `watchEvents` batches into turn events, following the table of the design: a model
 * request per `turn_start`, coalesced `turn.token` for streamed text, `tool.call` and `tool.result` around a tool. An
 * assistant message starts with the text it already has when the first batch is delivered, then grows by deltas; text
 * the stream did not carry at all is added when the message ends, so the joined tokens of a message always equal its
 * text. Thinking, snapshots and the rest are not forwarded.
 *
 * @param writer Where events go.
 * @param coalescer Where streamed text goes.
 * @param attemptId The attempt named on `model.request`.
 * @param delivery Told when a batch that settled a submission has been handled.
 * @returns The listener to pass to `AgentEventStream.start`.
 */
export function createAgentEventListener(
	writer: TurnEventWriter,
	coalescer: TokenCoalescer,
	attemptId: string,
	delivery: AgentEventDelivery,
): (events: readonly AgentEvent[]) => Promise<void> {
	let streamedText = "";
	return async (events) => {
		const settledInBatch: number[] = [];
		for (const event of events) {
			switch (event.type) {
				case "submission":
					if (event.record.status === "done" || event.record.status === "unanswered") settledInBatch.push(event.record.id);
					break;
				case "turn_start":
					await coalescer.flush();
					await writer.write({ kind: "model.request", attemptId });
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						streamedText = textOf(event.message.content);
						coalescer.push(streamedText);
					}
					break;
				case "message_update":
					for (const change of event.changes) {
						if (change.type === "text_delta") {
							streamedText += change.delta;
							coalescer.push(change.delta);
						}
					}
					break;
				case "message_end": {
					const message = event.entry.model?.[0];
					if (message?.role === "assistant") {
						const fullText = textOf(message.content);
						if (fullText.length > streamedText.length && fullText.startsWith(streamedText)) {
							coalescer.push(fullText.slice(streamedText.length));
						}
						streamedText = "";
					}
					break;
				}
				case "tool_execution_start":
					await coalescer.flush();
					await writer.write({ kind: "tool.call", body: event.toolName, actionId: event.toolCallId });
					break;
				case "tool_execution_end": {
					await coalescer.flush();
					const result = event.entry?.model?.[0];
					const body = result?.role === "toolResult" ? textOf(result.content).slice(0, TOOL_RESULT_BODY_LIMIT) : event.toolName;
					await writer.write({ kind: "tool.result", body, actionId: event.toolCallId });
					break;
				}
				default:
					break;
			}
		}
		for (const submissionId of settledInBatch) delivery.noteSettled(submissionId);
	};
}
