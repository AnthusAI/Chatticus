"use client";

import { Pause, Play, Sparkles } from "lucide-react";
import { WorkspaceRoster } from "./WorkspaceRoster";
import { WorkspaceThread } from "./WorkspaceThread";
import type { BotAvatarState, WorkspaceMember, WorkspaceMessage } from "./types";

export type WorkspacePanelProps = {
  orgLabel: string;
  workspaceLabel: string;
  members: WorkspaceMember[];
  selectedMemberId: string | null;
  selectedMemberState: BotAvatarState;
  selectedMemberActivity?: string;
  messages: WorkspaceMessage[];
  draft: string;
  sending: boolean;
  sendError?: string | null;
  disabled?: boolean;
  composerPlaceholder?: string;
  rosterLoading?: boolean;
  rosterError?: string | null;
  onSelectMember: (member: WorkspaceMember) => void;
  onRetryRoster?: () => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** Present only when the caller wants a pause/resume control (the marketing demo). */
  paused?: boolean;
  onTogglePaused?: () => void;
};

export function WorkspacePanel({
  orgLabel,
  workspaceLabel,
  members,
  selectedMemberId,
  selectedMemberState,
  selectedMemberActivity,
  messages,
  draft,
  sending,
  sendError,
  disabled,
  composerPlaceholder,
  rosterLoading,
  rosterError,
  onSelectMember,
  onRetryRoster,
  onDraftChange,
  onSend,
  paused,
  onTogglePaused,
}: WorkspacePanelProps) {
  const selectedMember = members.find((member) => member.id === selectedMemberId) ?? null;

  return (
    <section
      aria-label="Workspace"
      className="rounded-[2rem] bg-surface p-2 text-surface-foreground sm:p-3"
    >
      <div className="flex items-center justify-between rounded-2xl bg-surface-raised px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[0.6rem] bg-signal text-ink">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <div>
            <p className="font-mono text-[0.52rem] uppercase tracking-[0.14em] text-surface-foreground/60">{orgLabel}</p>
            <p className="font-body text-xs font-extrabold">{workspaceLabel}</p>
          </div>
        </div>
        {onTogglePaused ? (
          <button
            type="button"
            onClick={onTogglePaused}
            aria-pressed={paused}
            aria-label={paused ? "Resume workspace preview motion" : "Pause workspace preview motion"}
            className="flex min-h-7 items-center gap-1.5 rounded-full px-1.5 font-mono text-[0.52rem] uppercase tracking-[0.1em] text-surface-foreground/60 transition hover:bg-surface-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            {paused ? <Play className="h-3 w-3" aria-hidden="true" /> : <Pause className="h-3 w-3" aria-hidden="true" />}
            <span className="hidden min-[390px]:inline">{paused ? "resume" : "pause"}</span>
          </button>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[6.1rem_minmax(0,1fr)]">
        <WorkspaceRoster
          members={members}
          selectedMemberId={selectedMemberId}
          selectedMemberState={selectedMemberState}
          loading={rosterLoading}
          error={rosterError}
          onSelect={onSelectMember}
          onRetry={onRetryRoster}
        />
        <WorkspaceThread
          member={selectedMember}
          memberState={selectedMemberState}
          memberActivity={selectedMemberActivity}
          messages={messages}
          draft={draft}
          sending={sending}
          sendError={sendError}
          disabled={disabled}
          composerPlaceholder={composerPlaceholder}
          onDraftChange={onDraftChange}
          onSend={onSend}
        />
      </div>
    </section>
  );
}
