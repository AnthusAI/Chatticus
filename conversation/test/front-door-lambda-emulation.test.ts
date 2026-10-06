import { Writable } from "node:stream";
import { streamHandle } from "hono/aws-lambda";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSseProbeApp } from "../src/http/sse-probe.ts";
import { wallStreamClock } from "../src/http/stream.ts";

interface RecordedResponseMetadata {
	statusCode: number;
	headers: Record<string, string>;
}

class RecordingResponseStream extends Writable {
	chunks: string[] = [];
	metadata: RecordedResponseMetadata | undefined;
	_write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.chunks.push(chunk.toString("utf8"));
		callback();
	}
}

type StreamingHandler = (
	event: unknown,
	responseStream: RecordingResponseStream,
	context: unknown,
) => Promise<void>;

function functionUrlEvent(
	path: string,
	query: string,
	headers: Record<string, string> = {},
): unknown {
	return {
		version: "2.0",
		routeKey: "$default",
		rawPath: path,
		rawQueryString: query,
		headers: { host: "abc.lambda-url.us-east-1.on.aws", ...headers },
		requestContext: {
			domainName: "abc.lambda-url.us-east-1.on.aws",
			http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "1.1.1.1" },
		},
		isBase64Encoded: false,
	};
}

const CONDITION_WAIT_ATTEMPTS = 1000;
const DISCONNECT_TEST_TIMEOUT_MILLISECONDS = 30_000;

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < CONDITION_WAIT_ATTEMPTS; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not reached");
}

describe("front door under the emulated Lambda response stream runtime", () => {
	let handler: StreamingHandler;
	const logged: string[] = [];

	beforeAll(async () => {
		(globalThis as Record<string, unknown>).awslambda = {
			streamifyResponse: (inner: StreamingHandler) => inner,
			HttpResponseStream: {
				from: (
					stream: RecordingResponseStream,
					metadata: RecordedResponseMetadata,
				) => {
					stream.metadata = metadata;
					return stream;
				},
			},
		};
		vi.spyOn(console, "log").mockImplementation((line: string) => {
			logged.push(line);
		});
		const module = await import("../src/lambdas/front-door.ts");
		handler = module.handler as unknown as StreamingHandler;
	});

	afterEach(() => {
		logged.length = 0;
	});

	it("answers GET /health with a JSON response", async () => {
		const stream = new RecordingResponseStream();
		await handler(functionUrlEvent("/health", ""), stream, {});
		expect(stream.metadata?.statusCode).toBe(200);
		expect(stream.chunks.join("")).toBe('{"ok":true}');
	});

	it("streams SSE frames with metadata and ends on the terminal kind", async () => {
		const stream = new RecordingResponseStream();
		await handler(functionUrlEvent("/sse-probe", "events=2&gap_ms=10"), stream, {});
		expect(stream.metadata?.statusCode).toBe(200);
		expect(stream.metadata?.headers["content-type"]).toContain(
			"text/event-stream",
		);
		const text = stream.chunks.join("");
		expect(text).toContain("event: probe.tick\nid: 1\n");
		expect(text).toContain("event: probe.completed\nid: 2\n");
		expect(stream.writableEnded).toBe(true);
	});

	it("honours Last-Event-ID passed through the Function URL event", async () => {
		const stream = new RecordingResponseStream();
		await handler(
			functionUrlEvent("/sse-probe", "events=3&gap_ms=10", { "last-event-id": "2" }),
			stream,
			{},
		);
		const text = stream.chunks.join("");
		expect(text).not.toContain("id: 2\n");
		expect(text).toContain("event: probe.completed\nid: 3\n");
	});

	it("does not fire onAbort on disconnect but ends the loop via the stalled write", async () => {
		const disconnectLogged: string[] = [];
		const disconnectHandler = streamHandle(
			createSseProbeApp({
				clock: wallStreamClock,
				heartbeatIntervalMilliseconds: 15_000,
				eventIntervalMilliseconds: 20,
				maximumStreamMilliseconds: 840_000,
				writeStallMilliseconds: 150,
				log: (line) => disconnectLogged.push(line),
			}),
		) as unknown as StreamingHandler;
		const stream = new RecordingResponseStream();
		const invocation = disconnectHandler(
			functionUrlEvent("/sse-probe", "events=100000"),
			stream,
			{},
		);
		await waitUntil(() => stream.chunks.length >= 1);
		stream.destroy();
		await invocation;
		await waitUntil(() => disconnectLogged.includes("sse-probe write stalled"));
		expect(disconnectLogged).not.toContain("sse-probe aborted");
	}, DISCONNECT_TEST_TIMEOUT_MILLISECONDS);
});
