"use client";

import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type TextMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { AlertTriangle, Clock3, RotateCcw, Send } from "lucide-react";
import { createContext, useContext, type FC, type ReactNode } from "react";

import { ChatButton as Button } from "./button";
import { MessageHeader, MessageFooter, MessageBody } from "./presentation";
import { MarkdownText } from "./MarkdownText";
import { TurnActivityBody, WorkingIndicator } from "./TurnActivityView";
import { EMPTY_TURN_ACTIVITY, type TurnActivity } from "../client/turn-activity";
import { SLOW_TURN_TEXT } from "../client/turn-presentation";
import { formatTime } from "./time";
import { cn } from "./utils";

const ChatticusTextPart: TextMessagePartComponent = ({ text }) => (
  <p className="whitespace-pre-wrap">{text}</p>
);

const ChatticusMarkdownTextPart: TextMessagePartComponent = ({ text }) => <MarkdownText text={text} />;

const ChatticusUserMessage: FC = () => {
  const createdAt = useAuiState(
    (state) => (state.message.metadata?.custom?.createdAt as string | undefined) ?? state.message.createdAt,
  );

  return (
    <MessagePrimitive.Root
      className="flex justify-end px-1"
      data-role="user"
    >
      <div className="max-w-[86%] rounded-3xl rounded-br-lg bg-surface-raised px-4 py-3 text-sm leading-6 sm:max-w-[76%]">
        <MessageHeader />
        <MessageBody><MessagePrimitive.Parts components={{ Text: ChatticusTextPart }} /></MessageBody>
        {createdAt ? (
          <time className="mt-1 block font-mono text-[0.58rem] text-surface-foreground/40">
            {formatTime(createdAt)}
          </time>
        ) : null}
        <MessageFooter />
      </div>
    </MessagePrimitive.Root>
  );
};

/** Re-sends the message behind the failed reply, or null when retry is unavailable. */
export const RetryFailedTurnContext = createContext<(() => void) | null>(null);

const ChatticusFailedReply: FC<{ authorLabel?: string }> = ({ authorLabel }) => {
  const retry = useContext(RetryFailedTurnContext);
  return (
    <MessagePrimitive.Root className="flex justify-start px-1" data-role="assistant" data-failed="true">
      <article
        role="status"
        className="w-full max-w-3xl rounded-2xl bg-surface-raised px-4 py-3 text-sm leading-6"
      >
        <MessageHeader />
        {authorLabel ? <p className="mb-1 text-xs font-bold">{authorLabel}</p> : null}
        <p className="flex items-start gap-2 text-clay">
          <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <MessageBody><MessagePrimitive.Parts components={{ Text: ChatticusTextPart }} /></MessageBody>
          </span>
        </p>
        {retry ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-2 h-8 gap-1.5 rounded-full px-3 text-xs"
            aria-label={`Retry: send your message to ${authorLabel ?? "the bot"} again`}
            onClick={retry}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        <MessageFooter />
      </article>
    </MessagePrimitive.Root>
  );
};

const ChatticusAssistantMessage: FC = () => {
  const authorLabel = useAuiState(
    (state) => state.message.metadata?.custom?.authorLabel as string | undefined,
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
  const failed = useAuiState((state) => Boolean(state.message.metadata?.custom?.failed));
  const activity = useAuiState(
    (state) =>
      (state.message.metadata?.custom?.activity as TurnActivity | undefined) ?? EMPTY_TURN_ACTIVITY,
  );
  const slow = useAuiState((state) => Boolean(state.message.metadata?.custom?.slow));
  const showWorkingIndicator = isStreamingShell && isRunning && activity.showWorkingIndicator;

  if (failed) {
    return <ChatticusFailedReply authorLabel={authorLabel} />;
  }

  return (
    <MessagePrimitive.Root className="flex justify-start px-1" data-role="assistant">
      <article className="w-full max-w-3xl px-3 py-1 text-sm leading-6">
        <MessageHeader />
        {authorLabel ? <p className="mb-1 text-xs font-bold">{authorLabel}</p> : null}
        <TurnActivityBody activity={activity} />
        {showWorkingIndicator ? (
          <>
            <WorkingIndicator phaseText={activity.phaseText} />
            {slow ? (
              <p className="mt-1 text-xs text-surface-foreground/55">{SLOW_TURN_TEXT}</p>
            ) : null}
          </>
        ) : isStreamingShell && isRunning ? (
          <p className="flex items-center gap-2 text-surface-foreground/55">
            <Clock3 size={15} aria-hidden="true" />
            <MessageBody><MessagePrimitive.Parts components={{ Text: ChatticusTextPart }} /></MessageBody>
          </p>
        ) : (
          <MessageBody><MessagePrimitive.Parts components={{ Text: ChatticusMarkdownTextPart }} /></MessageBody>
        )}
        {!isStreaming && createdAt ? (
          <time className="mt-1 block font-mono text-[0.58rem] text-surface-foreground/40">
            {formatTime(createdAt)}
          </time>
        ) : null}
        {!isStreaming ? <MessageFooter /> : null}
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

/** Optional host controls around the shared composer and transcript. */
export type ChatThreadProps = {
  emptyState?: ReactNode;
  composerPlaceholder?: string;
  composerAccessory?: ReactNode;
  composerActions?: ReactNode;
  composerStatus?: ReactNode;
  streamError?: string | null;
  onDismissStreamError?: () => void;
  sendBlockMessage?: string | null;
  className?: string;
};

/** Shared transcript and composer inside an assistant-ui runtime provider. */
export function ChatThread({
  emptyState,
  composerPlaceholder = "Send a message...",
  composerAccessory,
  composerActions,
  composerStatus,
  streamError,
  onDismissStreamError,
  sendBlockMessage,
  className,
}: ChatThreadProps) {
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport
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
                {composerActions}
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
              {sendBlockMessage ? (
                <div role="status" className="px-3 pb-2 text-xs text-surface-foreground/55">
                  {sendBlockMessage}
                </div>
              ) : null}
              {composerStatus}
            </ComposerPrimitive.Root>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </div>
  );
}
