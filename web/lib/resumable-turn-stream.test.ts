import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TurnEvent } from "./api";
import { createResumableTurnStream } from "./resumable-turn-stream";
import type { TurnStreamHandlers } from "./sse";

type OpenedConnection = {
  handlers: TurnStreamHandlers;
  lastEventId: number;
  closed: boolean;
};

function turnEvent(seq: number, kind = "turn.token"): TurnEvent {
  return { seq, kind } as TurnEvent;
}

function buildHarness(maximumRetries = 4) {
  const connections: OpenedConnection[] = [];
  const deliveredSeqs: number[] = [];
  const attemptStarts: boolean[] = [];
  const gaveUpMessages: string[] = [];
  const stream = createResumableTurnStream({
    maximumRetries,
    retryDelayMillisecondsForRetry: () => 1,
    openStream: (handlers, lastEventId) => {
      const connection = { handlers, lastEventId, closed: false };
      connections.push(connection);
      return () => {
        connection.closed = true;
      };
    },
    onAttemptStart: (isFirstAttempt) => attemptStarts.push(isFirstAttempt),
    onEvent: (event) => deliveredSeqs.push(event.seq),
    onGaveUp: (message) => gaveUpMessages.push(message),
  });
  return { stream, connections, deliveredSeqs, attemptStarts, gaveUpMessages };
}

const waitForRetryTimer = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("createResumableTurnStream", () => {
  it("opens one replacement connection after an error even if close also fires", async () => {
    const { stream, connections } = buildHarness();
    stream.start();
    connections[0].handlers.onError?.(new Error("network"));
    connections[0].handlers.onClose?.();
    await waitForRetryTimer();
    assert.equal(connections.length, 2);
    assert.equal(connections[0].closed, true);
    stream.close();
  });

  it("resumes from the last sequence even when no tokens have arrived", async () => {
    const { stream, connections, attemptStarts } = buildHarness();
    stream.start();
    connections[0].handlers.onEvent(turnEvent(1, "turn.started"));
    connections[0].handlers.onEvent(turnEvent(2, "turn.computer_booting"));
    connections[0].handlers.onClose?.();
    await waitForRetryTimer();
    assert.equal(connections[1].lastEventId, 2);
    assert.deepEqual(attemptStarts, [true, false]);
    stream.close();
  });

  it("drops replayed events at or below the last delivered sequence", () => {
    const { stream, connections, deliveredSeqs } = buildHarness();
    stream.start();
    connections[0].handlers.onEvent(turnEvent(1));
    connections[0].handlers.onEvent(turnEvent(2));
    connections[0].handlers.onEvent(turnEvent(2));
    connections[0].handlers.onEvent(turnEvent(1));
    connections[0].handlers.onEvent(turnEvent(3));
    assert.deepEqual(deliveredSeqs, [1, 2, 3]);
    stream.close();
  });

  it("does not reconnect after a deliberate close, even with a retry pending", async () => {
    const { stream, connections } = buildHarness();
    stream.start();
    connections[0].handlers.onClose?.();
    stream.close();
    await waitForRetryTimer();
    assert.equal(connections.length, 1);
  });

  it("does not reconnect after a terminal event", async () => {
    const { stream, connections, deliveredSeqs } = buildHarness();
    stream.start();
    connections[0].handlers.onEvent(turnEvent(1, "turn.completed"));
    connections[0].handlers.onClose?.();
    await waitForRetryTimer();
    assert.equal(connections.length, 1);
    assert.deepEqual(deliveredSeqs, [1]);
  });

  it("gives up once retries without progress are exhausted", async () => {
    const { stream, connections, gaveUpMessages } = buildHarness(2);
    stream.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      connections[attempt].handlers.onError?.(new Error("HTTP 503"));
      await waitForRetryTimer();
    }
    assert.equal(connections.length, 3);
    assert.deepEqual(gaveUpMessages, ["HTTP 503"]);
  });
});
