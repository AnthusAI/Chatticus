import { SLOW_TURN_TEXT } from "../../chat/client/turn-presentation";
export { SLOW_TURN_TEXT, TURN_SLOW_AFTER_MS, isTurnSlow } from "../../chat/client/turn-presentation";
import type { ThreadMessageLike } from "@assistant-ui/react";

import type { Message, Turn, TurnEvent } from "./api";
import { committedMessageActivity, type RetainedTurnActivity } from "./committed-activity";
import { reduceTurnActivity, type TurnActivity } from "./turn-activity";
import type { TurnUiStatus } from "./workspace-state";

export const STREAMING_MESSAGE_ID_PREFIX = "chatticus:streaming:";

export type ChatticusThreadMessage =
  | { kind: "committed"; message: Message; activity?: TurnActivity | null }
  | {
      kind: "streaming";
      turnId: string;
      botId: string;
      body: string;
      waitingFor: string | null;
      turnStatus: TurnUiStatus;
      slow: boolean;
      activity: TurnActivity;
    }
  | { kind: "failed"; failure: FailedTurn };

/** A turn that ended without an answer, still the last thing in its conversation. */
export type FailedTurn = {
  turnId: string;
  botId: string;
  reason: string;
  retryBody: string;
};

const FAILED_TURN_FALLBACK_REASON = "The bot could not answer this message.";

/**
 * The failed reply to show, if the conversation's latest turn failed and
 * nothing has been said since the message that prompted it.
 */
export function failedTurnForConversation(
  latestTurn: Turn | null,
  messages: Message[],
): FailedTurn | null {
  if (!latestTurn || latestTurn.status !== "failed" || latestTurn.prompt_message_seq == null) {
    return null;
  }
  const lastSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), 0);
  if (latestTurn.prompt_message_seq !== lastSeq) {
    return null;
  }
  const prompt = messages.find((message) => message.seq === latestTurn.prompt_message_seq);
  if (!prompt) {
    return null;
  }
  return {
    turnId: latestTurn.turn_id,
    botId: latestTurn.bot_id,
    reason: latestTurn.terminal_reason || FAILED_TURN_FALLBACK_REASON,
    retryBody: prompt.body,
  };
}

export function streamingMessageId(turnId: string): string {
  return `${STREAMING_MESSAGE_ID_PREFIX}${turnId}`;
}

export function buildChatticusThreadMessages(
  messages: Message[],
  turn: Turn | null,
  progress: string,
  turnStatus: TurnUiStatus,
  failedTurn: FailedTurn | null = null,
  slow = false,
  turnEvents: readonly TurnEvent[] = [],
  retained: RetainedTurnActivity | null = null,
): ChatticusThreadMessage[] {
  const latestMessage = messages[messages.length - 1];
  const liveReplyJustCommitted =
    turn !== null &&
    (turnStatus === "reconciling" || turnStatus === "completed") &&
    Boolean(latestMessage) &&
    latestMessage.author_kind === "bot" &&
    latestMessage.author_id === turn.bot_id;
  const liveReplyIsNew =
    liveReplyJustCommitted && latestMessage.seq > (turn?.prompt_message_seq ?? 0);
  const committed: ChatticusThreadMessage[] = messages.map((message) => {
    if (message.author_kind !== "bot") {
      return { kind: "committed" as const, message };
    }
    const keptLive =
      liveReplyIsNew && message === latestMessage
        ? reduceTurnActivity(turnEvents)
        : retained?.messageId === message.message_id
          ? retained.activity
          : null;
    const activity = committedMessageActivity(message, keptLive);
    return { kind: "committed" as const, message, activity: activity.hasActivity ? activity : null };
  });
  if (!turn) {
    return failedTurn ? [...committed, { kind: "failed", failure: failedTurn }] : committed;
  }

  if (liveReplyJustCommitted) {
    return committed;
  }

  return [
    ...committed,
    {
      kind: "streaming",
      turnId: turn.turn_id,
      botId: turn.bot_id,
      body: progress,
      waitingFor: turn.waiting_for,
      turnStatus,
      slow,
      activity: reduceTurnActivity(turnEvents),
    },
  ];
}

export function streamingAssistantPlaceholder(
  waitingFor: string | null,
  turnStatus: TurnUiStatus,
  slow = false,
): string {
  if (waitingFor) {
    return `Waiting for ${waitingFor}`;
  }
  if (slow && turnStatus === "active") {
    return SLOW_TURN_TEXT;
  }
  if (turnStatus === "reconciling") {
    return "Reconciling committed messages…";
  }
  if (turnStatus === "failed") {
    return "Turn failed";
  }
  return "Working…";
}

export function convertChatticusThreadMessage(
  item: ChatticusThreadMessage,
  botNameById: ReadonlyMap<string, string>,
): ThreadMessageLike {
  if (item.kind === "committed") {
    const message = item.message;
    const role = message.author_kind === "human" ? "user" : "assistant";
    const authorLabel =
      message.author_kind === "bot" ? botNameById.get(message.author_id) : undefined;
    return {
      id: message.message_id,
      role,
      content: [{ type: "text", text: message.body }],
      createdAt: new Date(message.created_at),
      metadata: {
        custom: {
          authorLabel,
          createdAt: message.created_at,
          seq: message.seq,
          activity: item.activity ?? undefined,
          isStreaming: false,
        },
      },
    };
  }

  if (item.kind === "failed") {
    return {
      id: `chatticus:failed:${item.failure.turnId}`,
      role: "assistant",
      content: [{ type: "text", text: item.failure.reason }],
      status: { type: "incomplete", reason: "error" },
      metadata: {
        custom: {
          authorLabel: botNameById.get(item.failure.botId),
          failed: true,
          retryBody: item.failure.retryBody,
          isStreaming: false,
        },
      },
    };
  }

  const authorLabel = botNameById.get(item.botId);
  const text =
    item.body || streamingAssistantPlaceholder(item.waitingFor, item.turnStatus, item.slow);
  const isRunning = item.turnStatus === "active" || item.turnStatus === "reconciling";

  return {
    id: streamingMessageId(item.turnId),
    role: "assistant",
    content: [{ type: "text", text }],
    status: isRunning ? { type: "running" } : undefined,
    metadata: {
      custom: {
        authorLabel,
        isStreamingShell: !item.body,
        activity: item.activity,
        slow: item.slow,
        isStreaming: true,
      },
    },
  };
}

export { textFromAppendMessageContent } from "../../chat/react/message-content";
