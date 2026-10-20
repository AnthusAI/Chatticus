import { RefreshCw } from "lucide-react";

import type { KanbusBoardCard, KanbusBoardColumn } from "@/lib/kanbus-board";
import type { KanbusBoardSnapshot } from "@/lib/kanbus-board-controller";
import { KANBUS_ISSUE_FILE_LIMIT } from "@/lib/kanbus-board";

export type KanbusBoardHandlers = {
  onRefresh: () => void;
};

const FOCUS_RING_CLASS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt";

const PRIORITY_TONE_CLASS: Readonly<Record<number, string>> = {
  0: "bg-clay/30",
  1: "bg-amber/30",
};

function RefreshButton({ busy, label, onRefresh }: { busy: boolean; label: string; onRefresh: () => void }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={busy}
      aria-label={label}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-high disabled:opacity-50 ${FOCUS_RING_CLASS}`}
    >
      <RefreshCw size={16} className={busy ? "animate-spin" : undefined} aria-hidden="true" />
    </button>
  );
}

function IssueCard({ card }: { card: KanbusBoardCard }) {
  return (
    <li
      data-testid={`kanbus-card-${card.id}`}
      className="rounded-[var(--kb-card-radius,0.75rem)] bg-[var(--kb-card-background,var(--surface-1))] p-3 shadow-[var(--kb-card-shadow,none)]"
    >
      <p className="text-sm font-semibold leading-5">{card.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[0.65rem] text-surface-foreground/65">
        <span data-testid={`kanbus-card-id-${card.status}`}>{card.id}</span>
        <span>{card.type}</span>
        <span data-testid="kanbus-card-priority" className={`rounded-full px-1.5 py-0.5 text-surface-foreground ${PRIORITY_TONE_CLASS[card.priority] ?? "bg-surface-high"}`}>
          {card.priorityName}
        </span>
      </div>
      {card.labels.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Labels">
          {card.labels.map((label) => (
            <li key={label} className="rounded-full bg-surface-high px-2 py-0.5 text-[0.65rem] font-semibold">{label}</li>
          ))}
        </ul>
      ) : null}
      {card.parent !== null || card.childCount > 0 ? (
        <p className="mt-2 text-[0.65rem] text-surface-foreground/55">
          {card.parent !== null ? `Under ${card.parent}` : null}
          {card.parent !== null && card.childCount > 0 ? ". " : null}
          {card.childCount > 0 ? `${card.childCount} ${card.childCount === 1 ? "child" : "children"}` : null}
        </p>
      ) : null}
    </li>
  );
}

function BoardColumn({ column }: { column: KanbusBoardColumn }) {
  return (
    <section
      aria-label={column.name}
      data-testid={`kanbus-column-${column.status}`}
      className="flex h-full min-h-0 w-[min(var(--kb-column-width,16rem),85%)] shrink-0 snap-start flex-col rounded-[var(--kb-column-radius,1rem)] bg-[var(--kb-column-background,var(--surface-0))] p-2"
    >
      <h3 className="flex items-baseline justify-between px-2 pb-2 pt-1 text-xs font-bold">
        <span>{column.name}</span>
        <span data-testid={`kanbus-column-count-${column.status}`} className="font-mono text-[0.65rem] text-surface-foreground/60">{column.total}</span>
      </h3>
      <ul className="flex min-h-0 flex-1 flex-col gap-[var(--kb-card-gap,0.5rem)] overflow-y-auto">
        {column.cards.map((card) => <IssueCard key={card.id} card={card} />)}
        {column.total === 0 ? <li className="px-2 py-3 text-xs text-surface-foreground/50">Nothing here</li> : null}
        {column.hiddenCount > 0 ? (
          <li data-testid={`kanbus-column-more-${column.status}`} className="px-2 py-2 text-xs text-surface-foreground/60">and {column.hiddenCount} more</li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * The Kanbus board panel as a pure view of a controller snapshot. Its look is set by documented CSS custom properties
 * (see docs/PANEL_PLUGINS.md): --kb-board-gap, --kb-column-width, --kb-column-radius, --kb-column-background,
 * --kb-card-radius, --kb-card-background, --kb-card-gap and --kb-card-shadow, each falling back to the workspace
 * surface tokens.
 */
export function KanbusBoardPanelView({ snapshot, handlers }: { snapshot: KanbusBoardSnapshot; handlers: KanbusBoardHandlers }) {
  const { phase } = snapshot;
  if (phase.status === "idle" || phase.status === "loading") {
    return (
      <div className="rounded-2xl bg-surface p-4 text-xs text-surface-foreground/65" data-testid="kanbus-board-state" role="status">
        Reading the board from the computer
      </div>
    );
  }
  if (phase.status === "empty" || phase.status === "error") {
    return (
      <div className="flex items-start justify-between gap-2 rounded-2xl bg-surface p-4" data-testid="kanbus-board-state" role={phase.status === "error" ? "alert" : "status"}>
        <div className="min-w-0">
          <p className="text-sm font-bold">{phase.title}</p>
          {phase.status === "empty" ? (
            <p className="mt-1 text-xs text-surface-foreground/65">A Kanbus project keeps one JSON file per issue under project/issues in a folder of the workspace.</p>
          ) : null}
        </div>
        <RefreshButton busy={snapshot.refreshing} label={phase.status === "error" ? "Try again" : "Look again"} onRefresh={handlers.onRefresh} />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="kanbus-board">
      <div className="flex items-start justify-between gap-2 px-1">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold" data-testid="kanbus-board-name">{phase.boardName} board</h2>
          <p className="text-xs text-surface-foreground/65" data-testid="kanbus-board-summary">
            {phase.issueCount} {phase.issueCount === 1 ? "issue" : "issues"}. <span data-testid="kanbus-board-source">{phase.source.text}</span>
          </p>
          {phase.skippedFileCount > 0 ? (
            <p className="text-xs text-surface-foreground/65" data-testid="kanbus-board-limit">
              Showing the {KANBUS_ISSUE_FILE_LIMIT} most recently changed of {KANBUS_ISSUE_FILE_LIMIT + phase.skippedFileCount} issues
            </p>
          ) : null}
          {phase.unreadableFileCount > 0 ? (
            <p className="text-xs text-surface-foreground/65" data-testid="kanbus-board-unreadable">
              {phase.unreadableFileCount} {phase.unreadableFileCount === 1 ? "file" : "files"} could not be read as an issue
            </p>
          ) : null}
        </div>
        <RefreshButton busy={snapshot.refreshing} label="Refresh the board" onRefresh={handlers.onRefresh} />
      </div>
      <div className="flex min-h-0 flex-1 snap-x gap-[var(--kb-board-gap,0.5rem)] overflow-x-auto pb-1" data-testid="kanbus-board-columns">
        {phase.columns.map((column) => <BoardColumn key={column.status} column={column} />)}
      </div>
    </div>
  );
}
