import type { ThreadMessageLike } from "@assistant-ui/react";

import type { Message, Turn } from "./api";
import type { TurnUiStatus } from "./workspace-state";

export const STREAMING_MESSAGE_ID_PREFIX = "chatticus:streaming:";

export type ChatticusThreadMessage =
  | { kind: "committed"; message: Message }
  | {
      kind: "streaming";
      turnId: string;
      botId: string;
      body: string;
      waitingFor: string | null;
      turnStatus: TurnUiStatus;
      slow: boolean;
    }
  | { kind: "failed"; failure: FailedTurn };

/** A turn that ended without an answer, still the last thing in its conversation. */
export type FailedTurn = {
  turnId: string;
  botId: string;
  reason: string;
  retryBody: string;
};

/** How long a turn may show no progress before the member is told it is slow. */
export const TURN_SLOW_AFTER_MS = 45_000;

export const SLOW_TURN_TEXT = "Still working. This is taking longer than expected.";

const FAILED_TURN_FALLBACK_REASON = "The bot could not answer this message.";

export function isTurnSlow(millisecondsWithoutProgress: number): boolean {
  return millisecondsWithoutProgress >= TURN_SLOW_AFTER_MS;
}

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
): ChatticusThreadMessage[] {
  const committed: ChatticusThreadMessage[] = messages.map((message) => ({
    kind: "committed" as const,
    message,
  }));
  if (!turn) {
    return failedTurn ? [...committed, { kind: "failed", failure: failedTurn }] : committed;
  }

  const latest = messages[messages.length - 1];
  const botAlreadyCommitted =
    (turnStatus === "reconciling" || turnStatus === "completed") &&
    Boolean(latest) &&
    latest.author_kind === "bot" &&
    latest.author_id === turn.bot_id;

  if (botAlreadyCommitted) {
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
    const authorBotName =
      message.author_kind === "bot" ? botNameById.get(message.author_id) : undefined;
    return {
      id: message.message_id,
      role,
      content: [{ type: "text", text: message.body }],
      createdAt: new Date(message.created_at),
      metadata: {
        custom: {
          authorBotName,
          createdAt: message.created_at,
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
          authorBotName: botNameById.get(item.failure.botId),
          failed: true,
          retryBody: item.failure.retryBody,
          isStreaming: false,
        },
      },
    };
  }

  const authorBotName = botNameById.get(item.botId);
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
        authorBotName,
        isStreamingShell: !item.body,
        isStreaming: true,
      },
    },
  };
}

type AppendContentPart = { type: string; text?: string };

export function textFromAppendMessageContent(
  content: readonly AppendContentPart[],
): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}
