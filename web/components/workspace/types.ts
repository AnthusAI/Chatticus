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

export type WorkspaceMessage = {
  id: string;
  author: WorkspaceMessageAuthor;
  authorLabel: string;
  body: string;
};

export type { BotAvatarState };
