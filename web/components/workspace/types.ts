import type { BotAvatarState, CreativeRole } from "anthus-vultus";

export type WorkspaceMember = {
  id: string;
  name: string;
  /** Explicit character role; falls back to name-based inference (see BotAvatarView) when omitted. */
  role?: CreativeRole;
  /** Small line under the member's name in the roster/header (title, activity, memory count, ...). */
  meta?: string;
};

export type WorkspaceMessageAuthor = "operator" | "bot";

export type WorkspaceMessageReaction = {
  emoji: string;
  /** How long after the message itself is revealed the reaction appears. */
  delayMs: number;
};

export type WorkspaceMessage = {
  id: string;
  author: WorkspaceMessageAuthor;
  authorLabel: string;
  body: string;
  /**
   * How long to show a typing indicator (from this message's own author)
   * immediately before this message is revealed, measured from when the
   * previous message in the thread finished revealing (or from mount, for
   * the first message). Omit or 0 for an instant reveal, no typing
   * indicator -- the correct default for real, already-committed messages.
   * Purely a reveal-timing hint for `WorkspaceThread`; it has no bearing on
   * anything else (there's no "typing" concept on the wire, only on a
   * message that's about to be shown).
   */
  typingBeforeMs?: number;
  /** A small reaction attached to this message once it's visible. */
  reaction?: WorkspaceMessageReaction;
};

export type { BotAvatarState };
