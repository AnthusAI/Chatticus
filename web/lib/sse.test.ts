import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setIdTokenSourceForTests } from "./api-auth";
import { openTurnStream } from "./sse";

const originalFetch = globalThis.fetch;

type RecordedRequest = { headers: Record<string, string>; signal: AbortSignal };

function frame(seq: number, kind: string): string {
  return `data: ${JSON.stringify({ seq, kind })}\n\n`;
}

function streamingResponse(frames: string[], endWithoutTerminal = true): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const text of frames) {
          controller.enqueue(encoder.encode(text));
        }
        if (endWithoutTerminal) {
          controller.close();
        }
      },
    }),
    { status: 200 },
  );
}

function installFetch(respond: (request: RecordedRequest) => Promise<Response>): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = {
      headers: { ...(init?.headers as Record<string, string>) },
      signal: init?.signal as AbortSignal,
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return requests;
}

function recordHandlers() {
  const record = { events: [] as number[], errors: [] as string[], closes: 0 };
  return {
    record,
    handlers: {
      onEvent: (event: { seq: number }) => record.events.push(event.seq),
      onError: (error: Error) => record.errors.push(error.message),
      onClose: () => {
        record.closes += 1;
      },
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  setIdTokenSourceForTests(async () => "token");
});

afterEach(() => {
  setIdTokenSourceForTests(null);
  globalThis.fetch = originalFetch;
});

describe("openTurnStream termination", () => {
  it("reports a failed connection through onError only", async () => {
    installFetch(async () => new Response("nope", { status: 503 }));
    const { record, handlers } = recordHandlers();
    openTurnStream("anthus", "turn-1", handlers as never);
    await settle();
    assert.deepEqual(record.errors, ["HTTP 503"]);
    assert.equal(record.closes, 0);
  });

  it("reports a stream that ends without a terminal event through onClose only", async () => {
    installFetch(async () => streamingResponse([frame(1, "turn.token")]));
    const { record, handlers } = recordHandlers();
    openTurnStream("anthus", "turn-1", handlers as never);
    await settle();
    assert.deepEqual(record.events, [1]);
    assert.equal(record.closes, 1);
    assert.deepEqual(record.errors, []);
  });

  it("closes exactly once after a terminal event and ignores frames after it", async () => {
    installFetch(async () =>
      streamingResponse([frame(1, "turn.token"), frame(2, "turn.completed"), frame(3, "turn.token")], false),
    );
    const { record, handlers } = recordHandlers();
    openTurnStream("anthus", "turn-1", handlers as never);
    await settle();
    assert.deepEqual(record.events, [1, 2]);
    assert.equal(record.closes, 1);
  });

  it("does not notify anyone when the caller closes the stream deliberately", async () => {
    const requests = installFetch(async () => streamingResponse([frame(1, "turn.token")], false));
    const { record, handlers } = recordHandlers();
    const closeStream = openTurnStream("anthus", "turn-1", handlers as never);
    await settle();
    closeStream();
    await settle();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(record.closes, 0);
    assert.deepEqual(record.errors, []);
  });

  it("never opens a connection when closed before the sign-in token resolves", async () => {
    let releaseToken: (token: string) => void = () => {};
    setIdTokenSourceForTests(() => new Promise<string>((resolve) => (releaseToken = resolve)));
    const requests = installFetch(async () => streamingResponse([frame(1, "turn.token")]));
    const { record, handlers } = recordHandlers();
    const closeStream = openTurnStream("anthus", "turn-1", handlers as never);
    closeStream();
    releaseToken("token");
    await settle();
    assert.equal(requests.length, 0);
    assert.equal(record.closes, 0);
  });

  it("resumes from the supplied last event id", async () => {
    const requests = installFetch(async () => streamingResponse([]));
    const { handlers } = recordHandlers();
    openTurnStream("anthus", "turn-1", handlers as never, 7);
    await settle();
    assert.equal(requests[0].headers["Last-Event-ID"], "7");
  });
});
