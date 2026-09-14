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
    };

export function streamingMessageId(turnId: string): string {
  return `${STREAMING_MESSAGE_ID_PREFIX}${turnId}`;
}

export function buildChatticusThreadMessages(
  messages: Message[],
  turn: Turn | null,
  progress: string,
  turnStatus: TurnUiStatus,
): ChatticusThreadMessage[] {
  const committed = messages.map((message) => ({ kind: "committed" as const, message }));
  if (!turn) {
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
    },
  ];
}

export function streamingAssistantPlaceholder(
  waitingFor: string | null,
  turnStatus: TurnUiStatus,
): string {
  if (waitingFor) {
    return `Waiting for ${waitingFor}`;
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
        },
      },
    };
  }

  const authorBotName = botNameById.get(item.botId);
  const text = item.body || streamingAssistantPlaceholder(item.waitingFor, item.turnStatus);
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
