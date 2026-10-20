import { RefreshCw } from "lucide-react";
import { IssueCollection } from "@kanbus/ui";

import { KANBUS_ISSUE_FILE_LIMIT } from "@/lib/kanbus-board";
import type { KanbusBoardSnapshot } from "@/lib/kanbus-board-controller";

export type KanbusBoardHandlers = {
  onRefresh: () => void;
};

const FOCUS_RING_CLASS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt";

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

/**
 * The Board tab around the Kanbus component: the loading, empty and error messages, the board name and where it came
 * from, and the refresh button. The columns and cards are drawn by `IssueCollection` from `@kanbus/ui`, inside a
 * wrapper (see styles/kanbus-board.css) that maps the component's variables to the workspace tokens. The panel only
 * reads: no selection handler is passed, so cards do nothing when pressed.
 */
export function KanbusBoardPanelFrame({
  snapshot,
  handlers,
  theme,
}: {
  snapshot: KanbusBoardSnapshot;
  handlers: KanbusBoardHandlers;
  theme: "light" | "dark";
}) {
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
            {phase.issues.length} {phase.issues.length === 1 ? "issue" : "issues"}. <span data-testid="kanbus-board-source">{phase.source.text}</span>
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
      <div className={`chatticus-kanbus-board min-h-0 flex-1${theme === "dark" ? " dark" : ""}`} data-testid="kanbus-board-columns">
        <IssueCollection issues={phase.issues} config={phase.config} view="board" initialScroll="start" emptyMessage="No issues" ariaLabel={`${phase.boardName} issues`} />
      </div>
    </div>
  );
}
