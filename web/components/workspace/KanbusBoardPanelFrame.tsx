import type { ReactNode } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { IssueCollection } from "@kanbus/ui";

import type { BoardPicker, BoardSelection, BoardView, BoardWorkspaceSnapshot } from "@/lib/board-workspace-controller";

export type KanbusBoardHandlers = {
  onRefresh: () => void;
  onSelect: (selection: BoardSelection) => void;
  onTogglePicker: () => void;
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

function isSelected(selection: BoardSelection, candidate: BoardSelection): boolean {
  if (selection.kind !== candidate.kind) return false;
  return selection.kind === "project" || (candidate.kind === "bot" && selection.botId === candidate.botId);
}

function PickerEntry({ testId, name, kindLabel, selected, onPick }: { testId: string; name: string; kindLabel: string; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      aria-label={`${kindLabel}: ${name}`}
      data-testid={testId}
      className={`flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm hover:bg-surface-high ${selected ? "bg-surface-high font-bold" : ""} ${FOCUS_RING_CLASS}`}
    >
      {name}
    </button>
  );
}

function PickerSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section aria-label={heading}>
      <h3 className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wide text-surface-foreground/65">{heading}</h3>
      <div className="grid gap-1">{children}</div>
    </section>
  );
}

function BoardPickerList({ picker, selection, handlers }: { picker: BoardPicker; selection: BoardSelection; handlers: KanbusBoardHandlers }) {
  return (
    <div className="rounded-2xl bg-surface p-2" data-testid="board-picker">
      <PickerSection heading="Project boards">
        {picker.projects.entries.map((entry) => (
          <PickerEntry
            key={`project:${entry.name}`}
            testId="board-picker-project-entry"
            name={entry.name}
            kindLabel="Project board"
            selected={isSelected(selection, { kind: "project" })}
            onPick={() => handlers.onSelect({ kind: "project" })}
          />
        ))}
        {picker.projects.message !== null ? (
          <p className="px-3 py-2 text-xs text-surface-foreground/65" data-testid="board-picker-project-message">{picker.projects.message}</p>
        ) : null}
      </PickerSection>
      <PickerSection heading="Bot boards">
        {picker.bots.entries.map((entry) => (
          <PickerEntry
            key={`bot:${entry.botId}`}
            testId="board-picker-bot-entry"
            name={entry.name}
            kindLabel="Bot board"
            selected={isSelected(selection, { kind: "bot", botId: entry.botId })}
            onPick={() => handlers.onSelect({ kind: "bot", botId: entry.botId })}
          />
        ))}
        {picker.bots.message !== null ? (
          <p className="px-3 py-2 text-xs text-surface-foreground/65" data-testid="board-picker-bot-message">{picker.bots.message}</p>
        ) : null}
      </PickerSection>
    </div>
  );
}

function BoardBody({ view, theme }: { view: BoardView; theme: "light" | "dark" }) {
  if (view.status === "loading") {
    return (
      <div className="rounded-2xl bg-surface p-4 text-xs text-surface-foreground/65" data-testid="kanbus-board-state" role="status">
        {view.message}
      </div>
    );
  }
  if (view.status === "empty" || view.status === "error") {
    return (
      <div className="rounded-2xl bg-surface p-4" data-testid="kanbus-board-state" role={view.status === "error" ? "alert" : "status"}>
        <p className="text-sm font-bold">{view.title}</p>
        {view.status === "empty" && view.hint !== null ? <p className="mt-1 text-xs text-surface-foreground/65">{view.hint}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="kanbus-board">
      <div className="px-1">
        <h2 className="truncate text-sm font-bold" data-testid="kanbus-board-name">{view.title}</h2>
        <p className="text-xs text-surface-foreground/65" data-testid="kanbus-board-summary">
          <span data-testid="kanbus-board-kind">{view.kindLabel}</span>. {view.countText}. <span data-testid="kanbus-board-source">{view.sourceText}</span>
        </p>
        {view.notes.map((note) => (
          <p key={note.testId} className="text-xs text-surface-foreground/65" data-testid={note.testId}>{note.text}</p>
        ))}
      </div>
      <div className={`chatticus-kanbus-board min-h-0 flex-1${theme === "dark" ? " dark" : ""}`} data-testid="kanbus-board-columns">
        <IssueCollection issues={view.issues} config={view.config} view="board" initialScroll="start" emptyMessage="No issues" ariaLabel={`${view.title} issues`} />
      </div>
    </div>
  );
}

/**
 * The Board tab around the Kanbus component: the picker over project boards and bot boards, the loading, empty and error
 * messages, and the refresh button. Whichever board is picked, the columns and cards are drawn by `IssueCollection` from
 * `@kanbus/ui`, inside one wrapper (see styles/kanbus-board.css) that maps the component's variables to the workspace
 * tokens. The panel only reads: no selection handler is passed, so cards do nothing when pressed.
 */
export function KanbusBoardPanelFrame({
  snapshot,
  handlers,
  theme,
}: {
  snapshot: BoardWorkspaceSnapshot;
  handlers: KanbusBoardHandlers;
  theme: "light" | "dark";
}) {
  const { view, picker } = snapshot;
  const refreshLabel = view.status === "error" ? "Try again" : view.status === "empty" ? "Look again" : "Refresh the board";
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          onClick={handlers.onTogglePicker}
          aria-expanded={picker.open}
          data-testid="board-picker-toggle"
          className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-bold hover:bg-surface-high ${FOCUS_RING_CLASS}`}
        >
          Boards
          <ChevronDown size={14} className={picker.open ? "rotate-180" : undefined} aria-hidden="true" />
        </button>
        <RefreshButton busy={snapshot.refreshing} label={refreshLabel} onRefresh={handlers.onRefresh} />
      </div>
      {picker.open ? <BoardPickerList picker={picker} selection={snapshot.selection} handlers={handlers} /> : null}
      <div className="min-h-0 flex-1">
        <BoardBody view={view} theme={theme} />
      </div>
    </div>
  );
}
