"use client";

import { cn } from "../../lib/utils";
import { BotAvatarView } from "../BotAvatarView";
import type { BotAvatarState, WorkspaceMember } from "./types";

type WorkspaceRosterProps = {
  members: WorkspaceMember[];
  selectedMemberId: string | null;
  selectedMemberState: BotAvatarState;
  loading?: boolean;
  error?: string | null;
  onSelect: (member: WorkspaceMember) => void;
  onRetry?: () => void;
  /** A shared DOM element the whole roster should notice and look toward (see WorkspaceThread/WorkspacePanel). */
  focusElement?: Element | null;
};

export function WorkspaceRoster({
  members,
  selectedMemberId,
  selectedMemberState,
  loading,
  error,
  onSelect,
  onRetry,
  focusElement,
}: WorkspaceRosterProps) {
  return (
    <aside className="rounded-2xl bg-surface-raised p-2" aria-label="Teammates">
      <p className="px-1 pb-2 font-mono text-[0.5rem] uppercase tracking-[0.13em] text-surface-foreground/60">
        Team · {members.length}
      </p>
      {loading ? <p className="px-1 pb-2 font-mono text-[0.6rem] text-surface-foreground/60">Loading roster…</p> : null}
      {error ? (
        <div className="px-1 pb-2">
          <p className="font-mono text-[0.6rem] text-clay">{error}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-full bg-surface-high px-2 py-1 font-mono text-[0.55rem] uppercase tracking-[0.08em]"
            >
              Retry roster
            </button>
          ) : null}
        </div>
      ) : null}
      {!loading && !error && members.length === 0 ? (
        <p className="px-1 pb-2 font-mono text-[0.6rem] text-surface-foreground/60">No teammates yet.</p>
      ) : null}
      <div className="grid grid-cols-4 gap-1 sm:grid-cols-1 sm:gap-1.5">
        {members.map((member) => {
          const selected = member.id === selectedMemberId;
          return (
            <button
              key={member.id}
              type="button"
              onClick={() => onSelect(member)}
              aria-pressed={selected}
              aria-label={`${member.name}${selected ? ", active" : ""}`}
              className={cn(
                "flex w-full flex-col items-center gap-1 rounded-xl p-1.5 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
                selected ? "bg-surface-high" : "hover:bg-surface-high/60",
              )}
            >
              <BotAvatarView
                botName={member.name}
                role={member.role}
                state={selected ? selectedMemberState : "neutral"}
                size={40}
                className="shrink-0"
                focusElement={focusElement}
              />
              <span className="hidden w-full min-w-0 sm:block">
                <span className="block truncate font-body text-[0.6rem] font-extrabold">{member.name}</span>
                {member.meta ? (
                  <span className="block break-words font-mono text-[0.4rem] uppercase leading-tight tracking-[0.04em] text-surface-foreground/60">
                    {member.meta}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
