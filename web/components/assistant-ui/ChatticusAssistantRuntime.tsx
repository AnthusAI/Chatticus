"use client";
import { useMemo } from "react";
import { ChatRuntime } from "../../../chat/react";
import { MessageCostSlot } from "../workspace/CostMarkers";
import type { Message, Turn, TurnEvent } from "@/lib/api";
import { buildChatticusThreadMessages, convertChatticusThreadMessage, type FailedTurn } from "@/lib/assistant-ui-bridge";
import type { RetainedTurnActivity } from "@/lib/committed-activity";
import type { TurnUiStatus } from "@/lib/workspace-state";
import type { ChatticusAssistantThreadProps } from "./ChatticusAssistantThread";

export type ChatticusAssistantRuntimeProps = {
  messages: Message[];
  turn: Turn | null;
  progress: string;
  turnStatus: TurnUiStatus;
  isSendDisabled: boolean;
  botNameById: ReadonlyMap<string, string>;
  onSendMessage: (text: string) => Promise<void>;
  failedTurn?: FailedTurn | null;
  turnIsSlow?: boolean;
  turnEvents?: readonly TurnEvent[];
  retainedActivity?: RetainedTurnActivity | null;
  onRetryFailedTurn?: (failure: FailedTurn) => Promise<void>;
  threadProps?: Omit<ChatticusAssistantThreadProps, "className">;
  className?: string;
};

/** Product adapter: the roster, durable turn state and cost ledger stay in Chatticus. */
export function ChatticusAssistantRuntime({ messages, turn, progress, turnStatus, isSendDisabled, botNameById, onSendMessage, failedTurn = null, turnIsSlow = false, turnEvents = [], retainedActivity = null, onRetryFailedTurn, threadProps, className }: ChatticusAssistantRuntimeProps) {
  const threadMessages = useMemo(() => buildChatticusThreadMessages(messages, turn, progress, turnStatus, failedTurn, turnIsSlow, turnEvents, retainedActivity)
    .map((message) => convertChatticusThreadMessage(message, botNameById)),
    [messages, turn, progress, turnStatus, failedTurn, turnIsSlow, turnEvents, retainedActivity, botNameById]);
  const retry = failedTurn && onRetryFailedTurn && !isSendDisabled ? () => void onRetryFailedTurn(failedTurn) : null;
  const messageSequenceById = useMemo(() => new Map(messages.map((message) => [message.message_id, message.seq])), [messages]);
  const presentation = useMemo(() => ({ footer: (id: string) => {
    const sequence = messageSequenceById.get(id);
    return sequence !== undefined ? <MessageCostSlot seq={sequence} /> : null;
  } }), [messageSequenceById]);
  return <ChatRuntime messages={threadMessages} isRunning={isSendDisabled} isSendDisabled={isSendDisabled}
    onSendMessage={onSendMessage} onRetryFailedTurn={retry} threadProps={threadProps}
    className={className} presentation={presentation} />;
}
