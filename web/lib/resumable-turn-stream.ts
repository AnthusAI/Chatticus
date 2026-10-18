import type { TurnEvent } from "./api";
import { isTerminalTurnEvent } from "./sse-parse";
import type { TurnStreamHandlers } from "./sse";

export type ResumableTurnStreamOptions = {
  openStream: (handlers: TurnStreamHandlers, lastEventId: number) => () => void;
  onAttemptStart: (isFirstAttempt: boolean) => void;
  onEvent: (event: TurnEvent) => void;
  onGaveUp: (message: string) => void;
  maximumRetries?: number;
  retryDelayMillisecondsForRetry?: (retryNumber: number) => number;
};

export type ResumableTurnStream = {
  start: () => void;
  close: () => void;
};

const DEFAULT_MAXIMUM_RETRIES = 4;

function exponentialBackoffMilliseconds(retryNumber: number): number {
  return Math.pow(2, retryNumber - 1) * 1000;
}

/**
 * One logical stream for a turn: at most one connection and one pending
 * reconnect at a time, always resumed from the last sequence seen, and with
 * replayed events dropped before they reach the caller.
 */
export function createResumableTurnStream(options: ResumableTurnStreamOptions): ResumableTurnStream {
  const maximumRetries = options.maximumRetries ?? DEFAULT_MAXIMUM_RETRIES;
  const retryDelayMillisecondsForRetry =
    options.retryDelayMillisecondsForRetry ?? exponentialBackoffMilliseconds;
  let retriesSinceLastEvent = 0;
  let lastSeenEventSeq = 0;
  let sawTerminalEvent = false;
  let deliberatelyClosed = false;
  let pendingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closeCurrentConnection: (() => void) | null = null;

  const closeConnection = () => {
    closeCurrentConnection?.();
    closeCurrentConnection = null;
  };

  const scheduleReconnectOrGiveUp = (messageWhenGivingUp: string) => {
    if (deliberatelyClosed || sawTerminalEvent || pendingReconnectTimer !== null) {
      return;
    }
    if (retriesSinceLastEvent >= maximumRetries) {
      options.onGaveUp(messageWhenGivingUp);
      return;
    }
    retriesSinceLastEvent += 1;
    pendingReconnectTimer = setTimeout(() => {
      pendingReconnectTimer = null;
      openConnection(false);
    }, retryDelayMillisecondsForRetry(retriesSinceLastEvent));
  };

  const openConnection = (isFirstAttempt: boolean) => {
    closeConnection();
    if (deliberatelyClosed) {
      return;
    }
    options.onAttemptStart(isFirstAttempt);
    closeCurrentConnection = options.openStream(
      {
        onEvent: (event) => {
          if (deliberatelyClosed || event.seq <= lastSeenEventSeq) {
            return;
          }
          lastSeenEventSeq = event.seq;
          retriesSinceLastEvent = 0;
          if (isTerminalTurnEvent(event.kind)) {
            sawTerminalEvent = true;
          }
          options.onEvent(event);
        },
        onError: (error) => scheduleReconnectOrGiveUp(error.message),
        onClose: () => scheduleReconnectOrGiveUp("Connection lost"),
      },
      lastSeenEventSeq,
    );
  };

  return {
    start: () => openConnection(true),
    close: () => {
      deliberatelyClosed = true;
      if (pendingReconnectTimer !== null) {
        clearTimeout(pendingReconnectTimer);
        pendingReconnectTimer = null;
      }
      closeConnection();
    },
  };
}
