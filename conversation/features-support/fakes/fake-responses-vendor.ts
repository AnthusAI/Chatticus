import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake vendor received. */
export type VendorRequest = {
	readonly method: string;
	readonly path: string;
	readonly headers: Record<string, string>;
	readonly body: string;
};

/** Token counts the fake vendor reports in the final event of its answers. */
export type VendorUsage = { readonly inputTokens: number; readonly outputTokens: number };

/** A fake OpenAI Responses endpoint on a loopback port, answering with a valid server-sent event stream. */
export type FakeResponsesVendor = {
	readonly baseUrl: string;
	readonly requests: VendorRequest[];
	/** Answer the next requests with this text and usage. */
	answer(text: string, usage: VendorUsage): void;
	/** Stop streaming after this many events until the returned function is called, so a client can show it saw the start before the end. */
	holdAfterEvents(eventCount: number): () => void;
	/** Answer the next requests with this status and body instead of a stream. */
	failWith(status: number, body: string): void;
	close(): Promise<void>;
};

async function readText(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

const event = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/**
 * The events of one Responses answer in the order the OpenAI API sends them.
 *
 * @param text The answer text.
 * @param usage Token counts of the call.
 * @param model Model the answer claims to come from.
 * @returns The stream chunks, one per event; the text arrives in two deltas.
 */
export function responsesAnswerEvents(text: string, usage: VendorUsage, model: string): string[] {
	const half = Math.max(1, Math.floor(text.length / 2));
	const response = { id: "resp_fake", object: "response", model, status: "in_progress", output: [] as unknown[] };
	const message = { id: "msg_fake", type: "message", role: "assistant", status: "in_progress", content: [] as unknown[] };
	const part = { type: "output_text", text: "", annotations: [] as unknown[] };
	const finishedPart = { ...part, text };
	const finishedMessage = { ...message, status: "completed", content: [finishedPart] };
	return [
		event("response.created", { sequence_number: 0, response }),
		event("response.output_item.added", { sequence_number: 1, output_index: 0, item: message }),
		event("response.content_part.added", { sequence_number: 2, item_id: "msg_fake", output_index: 0, content_index: 0, part }),
		event("response.output_text.delta", { sequence_number: 3, item_id: "msg_fake", output_index: 0, content_index: 0, delta: text.slice(0, half) }),
		event("response.output_text.delta", { sequence_number: 4, item_id: "msg_fake", output_index: 0, content_index: 0, delta: text.slice(half) }),
		event("response.output_text.done", { sequence_number: 5, item_id: "msg_fake", output_index: 0, content_index: 0, text }),
		event("response.content_part.done", { sequence_number: 6, item_id: "msg_fake", output_index: 0, content_index: 0, part: finishedPart }),
		event("response.output_item.done", { sequence_number: 7, output_index: 0, item: finishedMessage }),
		event("response.completed", {
			sequence_number: 8,
			response: {
				...response,
				status: "completed",
				output: [finishedMessage],
				usage: {
					input_tokens: usage.inputTokens,
					output_tokens: usage.outputTokens,
					total_tokens: usage.inputTokens + usage.outputTokens,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		}),
	];
}

/**
 * Start a fake Responses endpoint on 127.0.0.1. It records every request and streams its scripted answer one event at a
 * time, so a client that buffers would show up as one late burst.
 *
 * @param model Model name the answers claim.
 */
export async function startFakeResponsesVendor(model = "gpt-5-nano"): Promise<FakeResponsesVendor> {
	const requests: VendorRequest[] = [];
	let script: { kind: "answer"; text: string; usage: VendorUsage } | { kind: "fail"; status: number; body: string } = {
		kind: "answer",
		text: "Hello from the fake vendor.",
		usage: { inputTokens: 11, outputTokens: 7 },
	};
	let hold: { afterEvents: number; gate: Promise<void> } | null = null;
	const server: Server = createServer(async (incoming, outgoing) => {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
		}
		requests.push({ method: incoming.method ?? "", path: incoming.url ?? "", headers, body: await readText(incoming) });
		if (script.kind === "fail") {
			outgoing.writeHead(script.status, { "content-type": "application/json" });
			outgoing.end(script.body);
			return;
		}
		outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunks = responsesAnswerEvents(script.text, script.usage, model);
		for (const [index, chunk] of chunks.entries()) {
			outgoing.write(chunk);
			await new Promise((resolve) => setTimeout(resolve, 2));
			if (hold !== null && hold.afterEvents === index + 1) await hold.gate;
		}
		outgoing.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		answer: (text, usage) => {
			script = { kind: "answer", text, usage };
		},
		holdAfterEvents: (eventCount) => {
			let release: () => void = () => undefined;
			hold = { afterEvents: eventCount, gate: new Promise<void>((resolve) => (release = resolve)) };
			return () => release();
		},
		failWith: (status, body) => {
			script = { kind: "fail", status, body };
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
