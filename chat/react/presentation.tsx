"use client";
import { createContext, useContext, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";

/** Optional host presentation around a shared message, with no host domain types. */
export type MessagePresentation = {
  header?: (messageId: string) => ReactNode;
  body?: (messageId: string, sharedBody: ReactNode) => ReactNode;
  footer?: (messageId: string) => ReactNode;
};
export const MessagePresentationContext = createContext<MessagePresentation>({});

/** Host-owned attribution before a shared message body. */
export function MessageHeader() {
  const id = useAuiState((state) => state.message.id);
  return useContext(MessagePresentationContext).header?.(id) ?? null;
}

/** Host-owned activity or controls after a shared message body. */
export function MessageFooter() {
  const id = useAuiState((state) => state.message.id);
  return useContext(MessagePresentationContext).footer?.(id) ?? null;
}

/** Allow domain-specific tool cards while sharing ordinary message rendering. */
export function MessageBody({ children }: { children: ReactNode }) {
  const id = useAuiState((state) => state.message.id);
  const render = useContext(MessagePresentationContext).body;
  return render ? render(id, children) : children;
}
