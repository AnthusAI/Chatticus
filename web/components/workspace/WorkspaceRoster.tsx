"use client";

import { cn } from "@/lib/utils";
import { BotAvatarView } from "@/components/BotAvatarView";
import type { BotAvatarState, WorkspaceMember } from "./types";

type WorkspaceRosterProps = {
  members: WorkspaceMember[];
  selectedMemberId: string | null;
  selectedMemberState: BotAvatarState;
  loading?: boolean;
  error?: string | null;
  onSelect: (member: WorkspaceMember) => void;
  onRetry?: () => void;
};

export function WorkspaceRoster({
  members,
  selectedMemberId,
  selectedMemberState,
  loading,
  error,
  onSelect,
  onRetry,
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
      <div className="grid grid-cols-4 gap-1 sm:block sm:space-y-1">
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
                "flex w-full items-center justify-center gap-1.5 rounded-xl p-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:justify-start",
                selected ? "bg-surface-high" : "hover:bg-surface-high/60",
              )}
            >
              <BotAvatarView
                botName={member.name}
                role={member.role}
                state={selected ? selectedMemberState : "neutral"}
                size={40}
                className="shrink-0"
              />
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate font-body text-[0.62rem] font-extrabold">{member.name}</span>
                {member.meta ? (
                  <span className="block truncate font-mono text-[0.43rem] uppercase tracking-[0.05em] text-surface-foreground/60">
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
