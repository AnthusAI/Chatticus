"use client";

import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type TextMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { Clock3, Send } from "lucide-react";
import type { FC, ReactNode } from "react";

import { Button } from "../ui/button";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const ChatticusTextPart: TextMessagePartComponent = ({ text }) => (
  <p className="whitespace-pre-wrap">{text}</p>
);

const ChatticusUserMessage: FC = () => {
  const createdAt = useAuiState(
    (state) => (state.message.metadata?.custom?.createdAt as string | undefined) ?? state.message.createdAt,
  );

  return (
    <MessagePrimitive.Root
      className="flex justify-end px-1"
      data-role="user"
    >
      <div className="max-w-[86%] rounded-3xl bg-surface-raised px-4 py-3 text-sm leading-6 sm:max-w-[76%]">
        <MessagePrimitive.Parts components={{ Text: ChatticusTextPart }} />
        {createdAt ? (
          <time className="mt-1 block font-mono text-[0.58rem] text-surface-foreground/40">
            {formatTime(createdAt)}
          </time>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
};

const ChatticusAssistantMessage: FC = () => {
  const authorBotName = useAuiState(
    (state) => state.message.metadata?.custom?.authorBotName as string | undefined,
  );
  const isStreamingShell = useAuiState(
    (state) => Boolean(state.message.metadata?.custom?.isStreamingShell),
  );
  const isStreaming = useAuiState(
    (state) => Boolean(state.message.metadata?.custom?.isStreaming),
  );
  const isRunning = useAuiState((state) => state.message.status?.type === "running");
  const createdAt = useAuiState(
    (state) => (state.message.metadata?.custom?.createdAt as string | undefined) ?? state.message.createdAt,
  );

  return (
    <MessagePrimitive.Root className="flex justify-start px-1" data-role="assistant">
      <article className="max-w-[86%] rounded-3xl bg-surface-raised px-4 py-3 text-sm leading-6 sm:max-w-[76%]">
        {authorBotName ? <p className="mb-1 text-xs font-bold">{authorBotName}</p> : null}
        {isStreamingShell && isRunning ? (
          <p className="flex items-center gap-2 text-surface-foreground/55">
            <Clock3 size={15} aria-hidden="true" />
            <MessagePrimitive.Parts components={{ Text: ChatticusTextPart }} />
          </p>
        ) : (
          <MessagePrimitive.Parts components={{ Text: ChatticusTextPart }} />
        )}
        {!isStreaming && createdAt ? (
          <time className="mt-1 block font-mono text-[0.58rem] text-surface-foreground/40">
            {formatTime(createdAt)}
          </time>
        ) : null}
      </article>
    </MessagePrimitive.Root>
  );
};

const ChatticusThreadMessage: FC = () => {
  const role = useAuiState((state) => state.message.role);
  if (role === "user") {
    return <ChatticusUserMessage />;
  }
  return <ChatticusAssistantMessage />;
};

export type ChatticusAssistantThreadProps = {
  emptyState?: ReactNode;
  composerPlaceholder?: string;
  composerAccessory?: ReactNode;
  streamError?: string | null;
  onDismissStreamError?: () => void;
  className?: string;
};

export function ChatticusAssistantThread({
  emptyState,
  composerPlaceholder = "Send a message...",
  composerAccessory,
  streamError,
  onDismissStreamError,
  className,
}: ChatticusAssistantThreadProps) {
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport
          turnAnchor="top"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 sm:px-5"
        >
          {!hasMessages && emptyState ? (
            <div className="flex min-h-0 flex-1 flex-col">{emptyState}</div>
          ) : null}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-5">
            <ThreadPrimitive.Messages components={{ Message: ChatticusThreadMessage }} />
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-surface px-3 pb-2 pt-2 sm:px-5">
            {composerAccessory}
            <ComposerPrimitive.Root className="rounded-3xl bg-surface-raised p-2">
              <div className="flex items-end gap-2">
                <ComposerPrimitive.Input
                  placeholder={composerPlaceholder}
                  rows={1}
                  className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm outline-none placeholder:text-surface-foreground/40"
                  aria-label="Message input"
                />
                <AuiIf condition={(state) => !state.thread.isRunning}>
                  <ComposerPrimitive.Send asChild>
                    <Button
                      type="submit"
                      size="icon"
                      className="shrink-0 shadow-none"
                      aria-label="Send message"
                    >
                      <Send size={17} aria-hidden="true" />
                    </Button>
                  </ComposerPrimitive.Send>
                </AuiIf>
              </div>
              {streamError ? (
                <div role="alert" className="flex items-start gap-2 px-3 pb-2 text-xs text-clay">
                  <span className="min-w-0 flex-1">{streamError}</span>
                  {onDismissStreamError ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-lg p-1 hover:bg-clay/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
                      aria-label="Dismiss stream error"
                      onClick={onDismissStreamError}
                    >
                      Dismiss
                    </button>
                  ) : null}
                </div>
              ) : null}
            </ComposerPrimitive.Root>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </div>
  );
}
