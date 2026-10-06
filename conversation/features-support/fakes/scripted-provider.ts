import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Token counts a scripted answer reports, as a real provider would. */
export type ScriptedUsage = { readonly input: number; readonly output: number };

/** The default usage every scripted answer reports unless a step says otherwise. */
export const DEFAULT_SCRIPTED_USAGE: ScriptedUsage = { input: 10, output: 5 };

type ScriptedStep =
	| { readonly kind: "reply"; readonly text: string; readonly usage: ScriptedUsage }
	| {
			readonly kind: "toolCall";
			readonly name: string;
			readonly args: Record<string, unknown>;
			readonly leadingText: string;
			readonly usage: ScriptedUsage;
	  }
	| { readonly kind: "providerError"; readonly status: number; readonly code: string | null }
	| { readonly kind: "networkError" };

/** A pause the provider holds before answering its next request, released by the scenario. */
export type ScriptedHold = { readonly release: () => void; readonly reached: Promise<void> };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const providerErrorText = (status: number, code: string | null): string => {
	if (code === null) return `${status} status code (no body)`;
	return `OpenAI API error (${status}): ${JSON.stringify({ message: `scripted ${code}`, type: code, param: null, code })}`;
};

/**
 * A pi-ai provider whose answers come from a script, standing in for the model vendor. It streams text in small deltas
 * like a real provider, reports the token counts the script gives it, and can fail the way the OpenAI SDK fails.
 */
export class ScriptedProvider {
	readonly providerId: string;
	readonly modelId: string;
	readonly provider: Provider;
	readonly requests: string[] = [];
	private readonly steps: ScriptedStep[] = [];
	private readonly holds: Array<{ release: () => void; gate: Promise<void>; reached: () => void }> = [];
	private repeatingStep: ScriptedStep | null = null;
	callCount = 0;

	/**
	 * @param providerId Provider id the Harness resolves the model through.
	 * @param modelId Model id the provider serves.
	 */
	constructor(providerId = "openai", modelId = "scripted-model") {
		this.providerId = providerId;
		this.modelId = modelId;
		const model = {
			id: modelId,
			name: modelId,
			api: "scripted",
			provider: providerId,
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		} as Model<string>;
		this.provider = createProvider({
			id: providerId,
			auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: {
				stream: (requestModel, context, options) => this.stream(requestModel, context, options?.signal),
				streamSimple: (requestModel, context, options) => this.stream(requestModel, context, options?.signal),
			},
		});
	}

	/** Queue a plain text answer. */
	reply(text: string, usage: ScriptedUsage = DEFAULT_SCRIPTED_USAGE): this {
		this.steps.push({ kind: "reply", text, usage });
		return this;
	}

	/** Queue an assistant message that calls a tool, optionally after some text the model says first. */
	toolCall(
		name: string,
		args: Record<string, unknown>,
		leadingText = "",
		usage: ScriptedUsage = DEFAULT_SCRIPTED_USAGE,
	): this {
		this.steps.push({ kind: "toolCall", name, args, leadingText, usage });
		return this;
	}

	/** Whether any answer is queued or every request is scripted to fail. */
	get isScripted(): boolean {
		return this.steps.length > 0 || this.repeatingStep !== null;
	}

	/** Queue a failure the way the OpenAI SDK reports an HTTP error, with or without the provider's error code. */
	providerError(status: number, code: string | null): this {
		this.steps.push({ kind: "providerError", status, code });
		return this;
	}

	/** Queue a transport failure with no HTTP response. */
	networkError(): this {
		this.steps.push({ kind: "networkError" });
		return this;
	}

	/** Answer every request after the queued ones with the same provider error. */
	alwaysProviderError(status: number, code: string | null): this {
		this.repeatingStep = { kind: "providerError", status, code };
		return this;
	}

	/**
	 * Hold the next request before it answers, until the scenario releases it.
	 *
	 * @returns A handle whose `reached` resolves when a request is waiting and whose `release` lets it answer.
	 */
	slow(): ScriptedHold {
		let release!: () => void;
		let reached!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reachedPromise = new Promise<void>((resolve) => {
			reached = resolve;
		});
		this.holds.push({ release, gate, reached });
		return { release, reached: reachedPromise };
	}

	private blankMessage(requestModel: Model<string>): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	private stream(requestModel: Model<string>, context: TranscriptContext, signal: AbortSignal | undefined) {
		const outer = createAssistantMessageEventStream();
		this.callCount += 1;
		this.requests.push(JSON.stringify(context));
		const hold = this.holds.shift();
		const step = this.steps.shift() ?? this.repeatingStep;
		queueMicrotask(async () => {
			const blank = this.blankMessage(requestModel);
			try {
				if (hold !== undefined) {
					hold.reached();
					await hold.gate;
				}
				if (signal?.aborted) {
					const aborted = { ...blank, stopReason: "aborted" as const, errorMessage: "Request was aborted" };
					outer.push({ type: "error", reason: "aborted", error: aborted });
					outer.end(aborted);
					return;
				}
				if (step === undefined || step === null || step.kind === "networkError") {
					const failed = {
						...blank,
						stopReason: "error" as const,
						errorMessage: step === undefined || step === null ? "No more scripted responses queued" : "Connection error.",
					};
					outer.push({ type: "error", reason: "error", error: failed });
					outer.end(failed);
					return;
				}
				if (step.kind === "providerError") {
					const failed = { ...blank, stopReason: "error" as const, errorMessage: providerErrorText(step.status, step.code) };
					outer.push({ type: "error", reason: "error", error: failed });
					outer.end(failed);
					return;
				}
				const usage = {
					input: step.usage.input,
					output: step.usage.output,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: step.usage.input + step.usage.output,
					cost: ZERO_COST,
				};
				outer.push({ type: "start", partial: { ...blank } });
				if (step.kind === "reply") {
					const partial = { ...blank, content: [{ type: "text" as const, text: "" }] };
					outer.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
					for (const delta of chunksOf(step.text, 12)) {
						await pause(DELTA_PAUSE_MILLISECONDS);
						partial.content = [{ type: "text", text: `${partial.content[0]!.text}${delta}` }];
						outer.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
					}
					outer.push({ type: "text_end", contentIndex: 0, content: step.text, partial: { ...partial } });
					const message = { ...blank, content: [{ type: "text" as const, text: step.text }], usage };
					outer.push({ type: "done", reason: "stop", message });
					outer.end(message);
					return;
				}
				const toolCall = { type: "toolCall" as const, id: `call-${this.callCount}`, name: step.name, arguments: step.args as never };
				const toolIndex = step.leadingText === "" ? 0 : 1;
				const content: AssistantMessage["content"] = [];
				if (step.leadingText !== "") {
					const partial = { ...blank, content: [{ type: "text" as const, text: "" }] };
					outer.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
					for (const delta of chunksOf(step.leadingText, 12)) {
						await pause(DELTA_PAUSE_MILLISECONDS);
						partial.content = [{ type: "text", text: `${partial.content[0]!.text}${delta}` }];
						outer.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
					}
					outer.push({ type: "text_end", contentIndex: 0, content: step.leadingText, partial: { ...partial } });
					content.push({ type: "text", text: step.leadingText });
				}
				const withCall = (calls: AssistantMessage["content"]) => ({ ...blank, content: [...content, ...calls] });
				outer.push({ type: "toolcall_start", contentIndex: toolIndex, partial: withCall([{ ...toolCall, arguments: {} }]) });
				outer.push({
					type: "toolcall_delta",
					contentIndex: toolIndex,
					delta: JSON.stringify(step.args),
					partial: withCall([{ ...toolCall, arguments: {} }]),
				});
				outer.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall, partial: withCall([toolCall]) });
				const message = { ...withCall([toolCall]), usage, stopReason: "toolUse" as const };
				outer.push({ type: "done", reason: "toolUse", message });
				outer.end(message);
			} catch (error) {
				const failed = {
					...blank,
					stopReason: "error" as const,
					errorMessage: error instanceof Error ? error.message : String(error),
				};
				outer.push({ type: "error", reason: "error", error: failed });
				outer.end(failed);
			}
		});
		return outer;
	}
}

const DELTA_PAUSE_MILLISECONDS = 40;

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function chunksOf(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
	return chunks.length > 0 ? chunks : [""];
}
