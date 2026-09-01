import type { TurnEvent } from "./api";
import { apiBase, tenantId } from "./config";
import { orgApiPath } from "./paths";
import { isTerminalTurnEvent, parseSseFrames } from "./sse-parse";

export type TurnStreamHandlers = {
  onEvent: (event: TurnEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
};

/** Open a turn-scoped SSE stream via fetch against the org-scoped front door. */
export function openTurnStream(
  turnId: string,
  handlers: TurnStreamHandlers,
  lastEventId?: number,
): () => void {
  const controller = new AbortController();
  let closed = false;

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  const invokeKey = process.env.NEXT_PUBLIC_CHATTICUS_INVOKE_KEY;
  if (invokeKey) {
    headers["X-Chatticus-Invoke-Key"] = invokeKey;
  }
  if (lastEventId && lastEventId > 0) {
    headers["Last-Event-ID"] = String(lastEventId);
  }

  void (async () => {
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
