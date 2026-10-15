import type { AgentEvent } from "@earendil-works/pi-durable";
import { appendTurnEvent, type TurnDependencies, type TurnEventDraft } from "../domain/turns.ts";
import type { TokenCoalescer } from "./coalescer.ts";
import { toolCallFields, toolResultFields } from "./tool-event-fields.ts";

/** The most characters of reasoning summary a turn's `turn.thinking` events carry in all. */
export const THINKING_CHARACTER_LIMIT = 2000;

type KnownCall = { toolName: string; writtenBytes: number | null; startedAtMilliseconds: number | null };

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

/** The plain text of a Pi message content. */
export const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
};

const thinkingOf = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "thinking" && typeof part.thinking === "string" ? part.thinking : "")).join("");
};

/** The tool call parts of a Pi assistant message content. */
export const toolCallsOf = (content: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> => {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const part of content) {
		if (part?.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
		const given = part.arguments;
		calls.push({ id: part.id, name: part.name, arguments: typeof given === "object" && given !== null ? given : {} });
	}
	return calls;
};

/**
 * Write the `tool.call` event of one Pi tool call unless it was already journaled. The listener and the executor's park
 * path both call this, and whichever claims the call first writes it, so a call is journaled once however the two
 * interleave and however many attempts see it.
 *
 * @param writer Where the event goes.
 * @param delivery Holds the claim on the call.
 * @param callId The Pi tool call id.
 * @param toolName The tool.
 * @param rawArguments The arguments the model gave.
 */
export async function writeToolCallOnce(
	writer: TurnEventWriter,
	delivery: AgentEventDelivery,
	callId: string,
	toolName: string,
	rawArguments: Readonly<Record<string, unknown>>,
): Promise<void> {
	if (!delivery.claimCallJournal(callId)) return;
	const fields = toolCallFields(toolName, callId, rawArguments);
	delivery.rememberCall(callId, { toolName, writtenBytes: fields.writtenBytes });
	await writer.write({
		kind: "tool.call",
		tool: fields.tool,
		callId: fields.callId,
		summary: fields.summary,
		toolArguments: fields.toolArguments,
		argumentsTruncated: fields.argumentsTruncated,
	});
}

/** What the executor learns from the Pi event listener besides the events it writes. */
export class AgentEventDelivery {
	private readonly settled = new Set<number>();
	private readonly journaledCalls = new Set<string>();
	private readonly knownCalls = new Map<string, KnownCall>();
	private thinkingCharacters = 0;
	private computerStartingOutstanding = false;
	private readonly waiters = new Map<number, Array<() => void>>();

	/**
	 * Claim the right to write the `tool.call` event of one Pi tool call. The listener and the executor's park path both
	 * write it, and whichever claims first does, so a call is journaled once however the two interleave.
	 *
	 * @param callId The Pi tool call id.
	 * @returns true the first time the call is claimed.
	 */
	claimCallJournal(callId: string): boolean {
		if (this.journaledCalls.has(callId)) return false;
		this.journaledCalls.add(callId);
		return true;
	}

	/** The call as the listener or the journal last described it, or undefined. */
	knownCall(callId: string): KnownCall | undefined {
		return this.knownCalls.get(callId);
	}

	/** Remember what is needed from a call to describe its result. */
	rememberCall(callId: string, call: Partial<KnownCall> & { toolName: string }): void {
		const previous = this.knownCalls.get(callId);
		this.knownCalls.set(callId, {
			toolName: call.toolName,
			writtenBytes: call.writtenBytes ?? previous?.writtenBytes ?? null,
			startedAtMilliseconds: call.startedAtMilliseconds ?? previous?.startedAtMilliseconds ?? null,
		});
	}

	/** Count reasoning summary characters already in the journal, so a resumed attempt keeps the turn's cap. */
	addThinkingCharacters(count: number): void {
		this.thinkingCharacters += count;
	}

	/**
	 * Take the part of a piece of reasoning summary that still fits in the turn's cap.
	 *
	 * @param text The piece the model streamed.
	 * @returns The part to emit, possibly empty.
	 */
	takeThinking(text: string): string {
		const room = Math.max(0, THINKING_CHARACTER_LIMIT - this.thinkingCharacters);
		const taken = text.slice(0, room);
		this.thinkingCharacters += taken.length;
		return taken;
	}

	/** Record whether the journal shows a `computer.starting` that no `computer.ready` has answered. */
	setComputerStartingOutstanding(outstanding: boolean): void {
		this.computerStartingOutstanding = outstanding;
	}

	/** Whether a `computer.starting` is waiting for its `computer.ready`. */
	get computerStarting(): boolean {
		return this.computerStartingOutstanding;
	}

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
 * request per `turn_start`, coalesced `turn.token` for streamed text, coalesced `turn.thinking` for a streamed reasoning
 * summary, `tool.call` with sanitized arguments and `tool.result` with a bounded output around a tool. A call the tool
 * gate blocked never starts, so its `tool.call` is written just before its `tool.result`, with the arguments the
 * assistant message carried. An assistant message starts with the text it already has when the first batch is
 * delivered, then grows by deltas; text the stream did not carry at all is added when the message ends, so the joined
 * tokens of a message always equal its text, and the same holds for the reasoning summary until the turn's cap. Snapshots
 * and the rest are not forwarded.
 *
 * @param writer Where events go.
 * @param coalescer Where streamed text goes.
 * @param thinking Where the streamed reasoning summary goes.
 * @param attemptId The attempt named on `model.request`.
 * @param delivery Told when a batch that settled a submission has been handled.
 * @returns The listener to pass to `AgentEventStream.start`.
 */
export function createAgentEventListener(
	writer: TurnEventWriter,
	coalescer: TokenCoalescer,
	thinking: TokenCoalescer,
	attemptId: string,
	delivery: AgentEventDelivery,
): (events: readonly AgentEvent[]) => Promise<void> {
	let streamedText = "";
	let streamedThinking = "";
	let thinkingUnflushed = false;
	const messageCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	const pushThinking = (text: string): void => {
		const taken = delivery.takeThinking(text);
		if (taken === "") return;
		thinking.push(taken);
		thinkingUnflushed = true;
	};
	const flushThinking = async (): Promise<void> => {
		if (!thinkingUnflushed) return;
		thinkingUnflushed = false;
		await thinking.flush();
	};
	const flushStreams = async (): Promise<void> => {
		await flushThinking();
		await coalescer.flush();
	};
	return async (events) => {
		const settledInBatch: number[] = [];
		for (const event of events) {
			switch (event.type) {
				case "submission":
					if (event.record.status === "done" || event.record.status === "unanswered") settledInBatch.push(event.record.id);
					break;
				case "turn_start":
					await flushStreams();
					await writer.write({ kind: "model.request", attemptId });
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						streamedThinking = thinkingOf(event.message.content);
						pushThinking(streamedThinking);
						await flushThinking();
						streamedText = textOf(event.message.content);
						coalescer.push(streamedText);
					}
					break;
				case "message_update":
					for (const change of event.changes) {
						if (change.type === "thinking_start" && change.block.type === "thinking") {
							streamedThinking += change.block.thinking;
							pushThinking(change.block.thinking);
						} else if (change.type === "thinking_delta") {
							streamedThinking += change.delta;
							pushThinking(change.delta);
						} else if (change.type === "text_delta") {
							await flushThinking();
							streamedText += change.delta;
							coalescer.push(change.delta);
						}
					}
					break;
				case "message_end": {
					const message = event.entry.model?.[0];
					if (message?.role === "assistant") {
						const fullThinking = thinkingOf(message.content);
						if (fullThinking.length > streamedThinking.length && fullThinking.startsWith(streamedThinking)) {
							pushThinking(fullThinking.slice(streamedThinking.length));
						}
						streamedThinking = "";
						await flushThinking();
						const fullText = textOf(message.content);
						if (fullText.length > streamedText.length && fullText.startsWith(streamedText)) {
							coalescer.push(fullText.slice(streamedText.length));
						}
						streamedText = "";
						for (const call of toolCallsOf(message.content)) messageCalls.set(call.id, { name: call.name, arguments: call.arguments });
					}
					break;
				}
				case "tool_execution_start":
					await flushStreams();
					delivery.rememberCall(event.toolCallId, { toolName: event.toolName, startedAtMilliseconds: Date.now() });
					await writeToolCallOnce(writer, delivery, event.toolCallId, event.toolName, event.args);
					break;
				case "tool_execution_end": {
					await flushStreams();
					await writeToolCallOnce(writer, delivery, event.toolCallId, event.toolName, messageCalls.get(event.toolCallId)?.arguments ?? {});
					const result = event.entry?.model?.[0];
					const known = delivery.knownCall(event.toolCallId);
					const started = known?.startedAtMilliseconds ?? null;
					const fields = toolResultFields(
						event.toolName,
						event.toolCallId,
						result?.role === "toolResult" ? textOf(result.content) : "",
						result?.role === "toolResult" ? result.isError === true : true,
						known?.writtenBytes ?? null,
						started === null ? null : Math.max(0, Date.now() - started),
					);
					await writer.write({
						kind: "tool.result",
						tool: fields.tool,
						callId: fields.callId,
						ok: fields.ok,
						summary: fields.summary,
						output: fields.output,
						outputTruncated: fields.outputTruncated,
						durationMs: fields.durationMs,
					});
					break;
				}
				default:
					break;
			}
		}
		for (const submissionId of settledInBatch) delivery.noteSettled(submissionId);
	};
}
