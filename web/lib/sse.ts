import type { TurnEvent } from "./api";
import { apiBase, tenantId } from "./config";

export type TurnStreamHandlers = {
  onEvent: (event: TurnEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
};

function parseSseFrames(
  buffer: string,
  onEvent: (event: TurnEvent) => void,
): string {
  let remainder = buffer;
  while (remainder.includes("\n\n")) {
    const splitAt = remainder.indexOf("\n\n");
    const frame = remainder.slice(0, splitAt);
    remainder = remainder.slice(splitAt + 2);
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }
    const event = JSON.parse(dataLine.slice(5).trim()) as TurnEvent;
    onEvent(event);
  }
  return remainder;
}

/** Open a turn-scoped SSE stream via fetch so X-Tenant-Id reaches the front door. */
export function openTurnStream(
  turnId: string,
  handlers: TurnStreamHandlers,
  lastEventId?: number,
): () => void {
  const controller = new AbortController();
  let closed = false;

  const headers: Record<string, string> = {
    "X-Tenant-Id": tenantId,
    Accept: "text/event-stream",
  };
  if (lastEventId && lastEventId > 0) {
    headers["Last-Event-ID"] = String(lastEventId);
  }

  void (async () => {
    try {
      const response = await fetch(
        `${apiBase}/turns/${encodeURIComponent(turnId)}/stream`,
        {
          headers,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error("stream body missing");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseFrames(buffer, (event) => {
          handlers.onEvent(event);
          if (
            event.kind === "turn.completed" ||
            event.kind === "turn.failed" ||
            event.kind === "turn.reconciling"
          ) {
            closed = true;
            controller.abort();
            handlers.onClose?.();
          }
        });
      }
      if (!closed) {
        handlers.onClose?.();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      handlers.onError?.(
        error instanceof Error ? error : new Error("turn stream failed"),
      );
      handlers.onClose?.();
    }
  })();

  return () => {
    closed = true;
    controller.abort();
    handlers.onClose?.();
  };
}
