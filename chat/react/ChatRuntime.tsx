"use client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useMemo, useRef } from "react";
import { ChatThread, RetryFailedTurnContext, type ChatThreadProps } from "./ChatThread";
import { textFromAppendMessageContent } from "./message-content";
import { MessagePresentationContext, type MessagePresentation } from "./presentation";

/** Host-normalized message data; no login, roster, backend or model runtime is required. */
export type ChatMessage = ThreadMessageLike;

const EMPTY_PRESENTATION: MessagePresentation = {};
const convertMessage = (message: ChatMessage): ThreadMessageLike => message;

/** Controlled host adapter for the shared transcript, activity and composer. */
export type ChatRuntimeProps = {
  messages: readonly ChatMessage[];
  isRunning: boolean;
  isSendDisabled: boolean;
  onSendMessage: (text: string) => Promise<void>;
  onRetryFailedTurn?: (() => void) | null;
  threadProps?: Omit<ChatThreadProps, "className">;
  presentation?: MessagePresentation;
  className?: string;
};

/** Render a host conversation through the shared assistant-ui external-store adapter. */
export function ChatRuntime({ messages, isRunning, isSendDisabled, onSendMessage, onRetryFailedTurn = null, threadProps, presentation = EMPTY_PRESENTATION, className }: ChatRuntimeProps) {
  const sending = useRef(false);
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = textFromAppendMessageContent(message.content).trim();
    if (!text || sending.current || isSendDisabled) return;
    sending.current = true;
    try { await onSendMessage(text); } finally { sending.current = false; }
  }, [isSendDisabled, onSendMessage]);
  const threadMessages = useMemo(() => [...messages], [messages]);
  const runtime = useExternalStoreRuntime({ messages: threadMessages, convertMessage, isRunning, isSendDisabled, onNew });
  return <div className="chatticus-chat">
    <AssistantRuntimeProvider runtime={runtime}>
      <MessagePresentationContext.Provider value={presentation}>
        <RetryFailedTurnContext.Provider value={onRetryFailedTurn}>
          <ChatThread className={className} {...threadProps} />
        </RetryFailedTurnContext.Provider>
      </MessagePresentationContext.Provider>
    </AssistantRuntimeProvider>
  </div>;
}
