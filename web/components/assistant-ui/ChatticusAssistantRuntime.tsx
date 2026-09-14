"use client";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { useCallback, useMemo, type ReactNode } from "react";

import type { Message, Turn } from "@/lib/api";
import {
  buildChatticusThreadMessages,
  convertChatticusThreadMessage,
  textFromAppendMessageContent,
  type ChatticusThreadMessage,
} from "@/lib/assistant-ui-bridge";
import type { TurnUiStatus } from "@/lib/workspace-state";

import { ChatticusAssistantThread, type ChatticusAssistantThreadProps } from "./ChatticusAssistantThread";

export type ChatticusAssistantRuntimeProps = {
  messages: Message[];
  turn: Turn | null;
  progress: string;
  turnStatus: TurnUiStatus;
  isSendDisabled: boolean;
  botNameById: ReadonlyMap<string, string>;
  onSendMessage: (text: string) => Promise<void>;
  threadProps?: Omit<ChatticusAssistantThreadProps, "className">;
  className?: string;
};

function ChatticusAssistantRuntimeInner({
  messages,
  turn,
  progress,
  turnStatus,
  isSendDisabled,
  botNameById,
  onSendMessage,
  threadProps,
  className,
}: ChatticusAssistantRuntimeProps) {
  const threadMessages = useMemo(
    () => buildChatticusThreadMessages(messages, turn, progress, turnStatus),
    [messages, progress, turn, turnStatus],
  );

  const isRunning = isSendDisabled;

  const convertMessage = useCallback(
    (message: ChatticusThreadMessage) => convertChatticusThreadMessage(message, botNameById),
    [botNameById],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = textFromAppendMessageContent(message.content);
      if (!text.trim()) {
        return;
      }
      await onSendMessage(text.trim());
    },
    [onSendMessage],
  );

  const runtime = useExternalStoreRuntime({
    messages: threadMessages,
    convertMessage,
    isRunning,
    isSendDisabled,
    onNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatticusAssistantThread className={className} {...threadProps} />
    </AssistantRuntimeProvider>
  );
}

export function ChatticusAssistantRuntime(props: ChatticusAssistantRuntimeProps): ReactNode {
  return <ChatticusAssistantRuntimeInner {...props} />;
}
