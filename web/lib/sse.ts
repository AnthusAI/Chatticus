import type { TurnEvent } from "./api";
import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";
import { orgApiPath } from "./paths";
import { isTerminalTurnEvent, parseSseFrames } from "./sse-parse";

export type TurnStreamHandlers = {
  onEvent: (event: TurnEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
};

/** Open a turn-scoped SSE stream via fetch against the org-scoped front door. */
export function openTurnStream(
  tenantId: string,
  turnId: string,
  handlers: TurnStreamHandlers,
  lastEventId?: number,
): () => void {
  const controller = new AbortController();
  let closed = false;

  void (async () => {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(await authorizedHeaders()),
    };
    if (lastEventId && lastEventId > 0) {
      headers["Last-Event-ID"] = String(lastEventId);
    }

    try {
      const response = await fetch(
        `${apiBase}${orgApiPath(tenantId, `/turns/${encodeURIComponent(turnId)}/stream`)}`,
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
          if (isTerminalTurnEvent(event.kind)) {
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
