import type { TurnEvent } from "./protocol";
import type { ChatHttpTransport } from "./transport";
import { isTerminalTurnEvent, parseSseFrames } from "./sse-parse";

/** Callbacks for one observed turn; closing the observer does not cancel server work. */
export type TurnStreamHandlers = {
  onEvent: (event: TurnEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
};

/** The host owns the endpoint and fresh authentication headers for every attempt. */
export type TurnStreamTransport = ChatHttpTransport;

/** Observe persisted events from one turn through an authenticated HTTP response. */
export function openTurnEventStream(transport: TurnStreamTransport, handlers: TurnStreamHandlers, lastEventId?: number): () => void {
  const controller = new AbortController();
  let deliberatelyClosed = false;
  let endNotified = false;

  const notifyEndExactlyOnce = (notify: () => void) => {
    if (endNotified || deliberatelyClosed) {
      return;
    }
    endNotified = true;
    notify();
  };

  void (async () => {
    try {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        ...(await transport.headers()),
      };
      if (deliberatelyClosed) {
        return;
      }
      if (lastEventId && lastEventId > 0) {
        headers["Last-Event-ID"] = String(lastEventId);
      }

      const response = await (transport.fetch ?? fetch)(
        transport.url,
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
      let sawTerminalEvent = false;
      while (!deliberatelyClosed && !sawTerminalEvent) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseFrames(buffer, (event) => {
          if (deliberatelyClosed || sawTerminalEvent) {
            return;
          }
          handlers.onEvent(event);
          if (isTerminalTurnEvent(event.kind)) {
            sawTerminalEvent = true;
          }
        });
      }
      if (sawTerminalEvent) {
        controller.abort();
      }
      notifyEndExactlyOnce(() => handlers.onClose?.());
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      notifyEndExactlyOnce(() =>
        handlers.onError?.(
          error instanceof Error ? error : new Error("turn stream failed"),
        ),
      );
    }
  })();

  return () => {
    deliberatelyClosed = true;
    controller.abort();
  };
}
