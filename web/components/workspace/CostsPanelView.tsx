import type { FC, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CostCall, CostRow, CostTotals } from "@chatticus/host-protocol/costs";

import {
  COST_BASIS_COPY,
  breakdownLines,
  describeFigure,
  describeTotalsNotes,
  formatRecordedAt,
  formatTokens,
  formatCount,
  modelLines,
  monthLabel,
  pluralize,
  rowBadges,
  type BreakdownKind,
  type BreakdownLine,
  type CostFigure,
} from "@/lib/costs";
import type {
  CostScope,
  CostsErrorView,
  CostsSnapshot,
  DrilldownPhase,
  GroupPage,
  MessageFocus,
  TurnsPage,
} from "@/lib/costs-controller";
import type { CostsExportGrain } from "@/lib/costs-api";

/** What a click in the Costs view does; the controller supplies these. */
export type CostsHandlers = {
  onSetScope: (scope: CostScope) => void;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onRetry: () => void;
  onLoadMoreTurns: () => void;
  onLoadMoreGroups: (kind: "bot" | "channel") => void;
  onOpenTurn: (turnId: string) => void;
  onCloseDrilldown: () => void;
  onCloseMessageFocus: () => void;
  onExport: (grain: CostsExportGrain) => void;
};

/** How ids are shown to a person: the names the workspace knows. */
export type CostsLabels = {
  botName: (botId: string) => string;
  channelName: (channelId: string) => string;
};

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt";
const PILL_BUTTON = `inline-flex min-h-11 items-center justify-center rounded-full bg-surface px-4 text-xs font-bold hover:bg-surface-high ${FOCUS}`;
const CARD_BUTTON = `inline-flex min-h-11 items-center justify-center rounded-full bg-surface-raised px-4 text-xs font-bold hover:bg-surface-high ${FOCUS}`;
const ROW_BUTTON = `block min-h-11 w-full rounded-xl bg-surface-raised px-3 py-2 text-left text-xs hover:bg-surface-high ${FOCUS}`;
const SECTION = "rounded-2xl bg-surface p-4";
const MUTED = "text-surface-foreground/60";

const Badge: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="rounded-full bg-surface-high px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.08em]">{children}</span>
);

const FigureText: FC<{ figure: CostFigure; testId?: string; className?: string }> = ({ figure, testId, className }) => (
  <span data-testid={testId} className={className}>
    {figure.text}
  </span>
);

const IncompleteLine: FC<{ figure: CostFigure }> = ({ figure }) =>
  figure.incompleteLabel ? (
    <span className="block text-xs font-bold text-clay" role="status">
      {figure.incompleteLabel}
    </span>
  ) : null;

/** The notes under a total: unfinished turns, estimated rows, rows only the gateway saw. */
export const TotalsNotes: FC<{ totals: CostTotals }> = ({ totals }) => {
  const notes = describeTotalsNotes(totals);
  return notes.length === 0 ? null : (
    <ul className={`mt-2 space-y-1 text-xs ${MUTED}`}>
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
};

/** A read that failed, with the way out the error allows. */
export const CostsErrorNotice: FC<{ error: CostsErrorView; onRetry: () => void }> = ({ error, onRetry }) => (
  <div role="alert" className={`${SECTION} space-y-2`} data-testid="costs-error">
    <p className="text-xs font-semibold">{error.text}</p>
    {error.retryable ? (
      <button type="button" onClick={onRetry} className={CARD_BUTTON}>
        Try again
      </button>
    ) : null}
  </div>
);

const Loading: FC<{ label: string }> = ({ label }) => (
  <p role="status" className={`${SECTION} text-xs ${MUTED}`}>
    {label}
  </p>
);

/** Which costs are shown: the whole organization or the open conversation. */
export const ScopeSwitch: FC<{
  scope: CostScope;
  channelName: string | null;
  onSetScope: (scope: CostScope) => void;
}> = ({ scope, channelName, onSetScope }) =>
  channelName === null ? null : (
    <div role="group" aria-label="Costs shown" className="grid grid-cols-2 gap-1 rounded-2xl bg-surface p-1">
      <button
        type="button"
        aria-pressed={scope === "organization"}
        onClick={() => onSetScope("organization")}
        className={`min-h-11 rounded-xl px-2 text-xs font-bold ${FOCUS} ${scope === "organization" ? "bg-surface-high" : "hover:bg-surface-raised"}`}
      >
        Whole organization
      </button>
      <button
        type="button"
        aria-pressed={scope === "channel"}
        onClick={() => onSetScope("channel")}
        className={`min-h-11 min-w-0 truncate rounded-xl px-2 text-xs font-bold ${FOCUS} ${scope === "channel" ? "bg-surface-high" : "hover:bg-surface-raised"}`}
      >
        This conversation
      </button>
    </div>
  );

const MonthBar: FC<{
  month: string;
  canGoToPreviousMonth: boolean;
  canGoToNextMonth: boolean;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
}> = ({ month, canGoToPreviousMonth, canGoToNextMonth, onPreviousMonth, onNextMonth }) => (
  <div className="flex items-center justify-between gap-2">
    <button
      type="button"
      onClick={onPreviousMonth}
      disabled={!canGoToPreviousMonth}
      aria-label="Previous month"
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-high disabled:opacity-40 ${FOCUS}`}
    >
      <ChevronLeft size={18} aria-hidden="true" />
    </button>
    <p className="min-w-0 truncate text-center text-sm font-extrabold" data-testid="cost-period" aria-live="polite">
      {monthLabel(month)}
    </p>
    <button
      type="button"
      onClick={onNextMonth}
      disabled={!canGoToNextMonth}
      aria-label="Next month"
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-high disabled:opacity-40 ${FOCUS}`}
    >
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  </div>
);

/** The headline: the total of the shown costs, or what is missing from it, and the honest notes. */
export const CostHeadline: FC<{ totals: CostTotals; emptyText: string; title: string }> = ({ totals, emptyText, title }) => {
  if (totals.rows === 0) {
    return (
      <section className={SECTION} aria-label={title} data-testid="cost-empty">
        <p className="text-xs font-semibold">{emptyText}</p>
      </section>
    );
  }
  const figure = describeFigure(totals);
  return (
    <section className="rounded-2xl bg-surface-high p-4" aria-label={title} data-testid="cost-summary">
      <p className={`font-mono text-[0.6rem] uppercase tracking-[0.12em] ${MUTED}`}>{title}</p>
      <p className="mt-1 break-words text-2xl font-extrabold tracking-tight">
        <FigureText figure={figure} testId="cost-headline" />
      </p>
      <IncompleteLine figure={figure} />
      <p className={`mt-1 text-xs ${MUTED}`}>
        {pluralize(totals.turns, "turn")}, {pluralize(totals.calls, "model call")}
      </p>
      <TotalsNotes totals={totals} />
    </section>
  );
};

const Breakdown: FC<{
  kind: BreakdownKind;
  title: string;
  lines: BreakdownLine[];
  more?: { page: GroupPage; onMore: () => void } | null;
}> = ({ kind, title, lines, more }) =>
  lines.length === 0 ? null : (
    <section className={SECTION} aria-label={title} data-testid={`breakdown-${kind}`}>
      <h3 className="text-sm font-bold">{title}</h3>
      <ul className="mt-2 space-y-1">
        {lines.map((line) => (
          <li
            key={line.key ?? "none"}
            data-testid={`breakdown-${kind}-row`}
            data-label={line.label}
            className="rounded-xl bg-surface-raised px-3 py-2 text-xs"
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-words font-semibold">{line.label}</span>
              <span className="shrink-0 text-right font-mono">{line.figure.text}</span>
            </span>
            <span className={`block ${MUTED}`}>
              {line.turns > 0 ? `${pluralize(line.turns, "turn")}, ` : ""}
              {pluralize(line.calls, "call")}
            </span>
            <IncompleteLine figure={line.figure} />
          </li>
        ))}
      </ul>
      {more && more.page.next !== null ? (
        <button type="button" onClick={more.onMore} disabled={more.page.loadingMore} className={`${CARD_BUTTON} mt-2`}>
          {more.page.loadingMore ? "Loading" : `Show more ${kind === "bot" ? "bots" : "conversations"}`}
        </button>
      ) : null}
    </section>
  );

const TurnRow: FC<{ row: CostRow; labels: CostsLabels; onOpenTurn: (turnId: string) => void }> = ({ row, labels, onOpenTurn }) => {
  const figure = describeFigure(row.totals, "call");
  const badges = rowBadges(row);
  const bot = row.bot_id === null ? null : labels.botName(row.bot_id);
  const channel = row.channel_id === null ? null : labels.channelName(row.channel_id);
  const turnId = row.turn_id;
  const content = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-words font-semibold">{bot ?? "Model gateway"}</span>
        <span className="shrink-0 text-right font-mono">{figure.text}</span>
      </span>
      <span className={`block break-words ${MUTED}`}>
        {channel ?? "Not tied to a conversation"} - {formatRecordedAt(row.recorded_at)} - {pluralize(row.totals.calls, "call")}
      </span>
      {badges.length > 0 ? (
        <span className="mt-1 flex flex-wrap gap-1">
          {badges.map((badge) => (
            <Badge key={badge}>{badge}</Badge>
          ))}
        </span>
      ) : null}
      <IncompleteLine figure={figure} />
    </>
  );
  return (
    <li data-testid={`turn-row-${row.id}`}>
      {turnId === null ? (
        <div className="rounded-xl bg-surface-raised px-3 py-2 text-xs">{content}</div>
      ) : (
        <button type="button" onClick={() => onOpenTurn(turnId)} aria-label={`Open the model calls of turn ${turnId}`} className={ROW_BUTTON}>
          {content}
        </button>
      )}
    </li>
  );
};

/** The turns of the shown costs, newest first, a page at a time. */
export const TurnsList: FC<{
  title: string;
  page: TurnsPage;
  total: CostTotals;
  labels: CostsLabels;
  onOpenTurn: (turnId: string) => void;
  onLoadMore: () => void;
}> = ({ title, page, total, labels, onOpenTurn, onLoadMore }) => {
  const noun = total.rows === total.turns ? "turns" : "rows";
  return (
    <section className={SECTION} aria-label={title} data-testid="turns-list">
      <h3 className="text-sm font-bold">{title}</h3>
      <ul className="mt-2 space-y-1">
        {page.rows.map((row) => (
          <TurnRow key={row.id} row={row} labels={labels} onOpenTurn={onOpenTurn} />
        ))}
      </ul>
      {page.next !== null || page.rows.length < total.rows ? (
        <p className={`mt-2 text-xs ${MUTED}`}>
          Showing {formatCount(page.rows.length)} of {formatCount(total.rows)} {noun}
        </p>
      ) : null}
      {page.moreFailed ? <p role="alert" className="mt-2 text-xs font-semibold">Could not load more. Try again.</p> : null}
      {page.next !== null ? (
        <button type="button" onClick={onLoadMore} disabled={page.loadingMore} className={`${CARD_BUTTON} mt-2`}>
          {page.loadingMore ? "Loading" : `Show more ${noun}`}
        </button>
      ) : null}
    </section>
  );
};

const CallCard: FC<{ call: CostCall; index: number }> = ({ call, index }) => {
  const figure = call.unpriced || call.cost_usd === null ? null : describeFigure({ complete: true, cost_usd: call.cost_usd, priced_cost_usd: call.cost_usd, unpriced_calls: 0 }, "call");
  return (
    <li data-testid={`call-${index + 1}`} className="rounded-xl bg-surface-raised px-3 py-2 text-xs">
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-words font-semibold">
          {index + 1}. {call.model}
        </span>
        <span className="shrink-0 text-right font-mono">{figure ? figure.text : "unpriced"}</span>
      </span>
      <span className={`block ${MUTED}`}>
        {formatTokens(call.input_tokens)} input, {formatTokens(call.cache_read_tokens)} cached read,{" "}
        {formatTokens(call.cache_write_tokens)} cache write, {formatTokens(call.output_tokens)} output
        {call.reasoning_tokens > 0 ? ` (${formatTokens(call.reasoning_tokens)} reasoning, counted in output)` : ""}
      </span>
      <span className={`block ${MUTED}`}>
        {call.tier === null ? "no tier" : `${call.tier === "long_context" ? "long context" : "standard"} tier`}, {call.price_book_id}
        {call.kind === "turn_round" ? `, round ${call.round}` : `, ${call.kind.replace("_", " ")}`}
      </span>
      {call.unpriced ? <span className="block font-bold text-clay">This call has no price, so it is left out of the total.</span> : null}
    </li>
  );
};

/** One turn opened to its model calls. */
export const TurnDrilldown: FC<{
  phase: DrilldownPhase;
  labels: CostsLabels;
  onClose: () => void;
  onRetry: (turnId: string) => void;
}> = ({ phase, labels, onClose, onRetry }) => {
  const back = (
    <button type="button" onClick={onClose} className={PILL_BUTTON}>
      Back to turns
    </button>
  );
  if (phase.status === "loading") {
    return (
      <div className="space-y-3" data-testid="turn-drilldown">
        {back}
        <Loading label="Loading the model calls" />
      </div>
    );
  }
  if (phase.status === "error") {
    return (
      <div className="space-y-3" data-testid="turn-drilldown">
        {back}
        <CostsErrorNotice error={phase.error} onRetry={() => onRetry(phase.turnId)} />
      </div>
    );
  }
  const { detail } = phase;
  const figure = describeFigure(detail.totals, "call");
  return (
    <div className="space-y-3" data-testid="turn-drilldown">
      {back}
      <section className="rounded-2xl bg-surface-high p-4" aria-label="Turn cost">
        <p className={`font-mono text-[0.6rem] uppercase tracking-[0.12em] ${MUTED}`}>Turn {detail.turn_id}</p>
        <p className="mt-1 break-words text-2xl font-extrabold tracking-tight">
          <FigureText figure={figure} testId="turn-total" />
        </p>
        <IncompleteLine figure={figure} />
        <p className={`mt-1 break-words text-xs ${MUTED}`}>
          {labels.botName(detail.bot_id)} in {labels.channelName(detail.channel_id)}
        </p>
        <TotalsNotes totals={detail.totals} />
      </section>
      <section className={SECTION} aria-label="Model calls">
        <h3 className="text-sm font-bold">Model calls</h3>
        {detail.calls_available ? (
          <ol className="mt-2 space-y-1" data-testid="call-list">
            {detail.calls.map((call, index) => (
              <CallCard key={`${call.conversation_id}-${call.entry_id}-${call.kind}`} call={call} index={index} />
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs font-semibold" role="status">
            The model calls of this turn could not be read.
          </p>
        )}
      </section>
    </div>
  );
};

const MessageTurns: FC<{
  focus: MessageFocus;
  labels: CostsLabels;
  onOpenTurn: (turnId: string) => void;
  onClose: () => void;
}> = ({ focus, labels, onOpenTurn, onClose }) => (
  <div className="space-y-3" data-testid="message-focus">
    <button type="button" onClick={onClose} className={PILL_BUTTON}>
      Back to costs
    </button>
    <section className={SECTION} aria-label="Turns behind this message" data-testid="turns-list">
      <h3 className="text-sm font-bold">Turns behind message {focus.seq}</h3>
      <ul className="mt-2 space-y-1">
        {focus.rows.map((row) => (
          <TurnRow key={row.id} row={row} labels={labels} onOpenTurn={onOpenTurn} />
        ))}
      </ul>
    </section>
  </div>
);

const ExportBar: FC<{ snapshot: CostsSnapshot; onExport: (grain: CostsExportGrain) => void; onRetry: () => void }> = ({
  snapshot,
  onExport,
  onRetry,
}) => {
  const phase = snapshot.exportPhase;
  const working = phase.status === "working";
  return (
    <section className={SECTION} aria-label="Download" data-testid="cost-export">
      <h3 className="text-sm font-bold">Download</h3>
      <div className="mt-2 grid gap-2 min-[420px]:grid-cols-2">
        <button type="button" onClick={() => onExport("turn")} disabled={working} className={CARD_BUTTON}>
          Download turns as CSV
        </button>
        <button type="button" onClick={() => onExport("call")} disabled={working} className={CARD_BUTTON}>
          Download calls as CSV
        </button>
      </div>
      {phase.status === "working" ? <p role="status" className={`mt-2 text-xs ${MUTED}`}>Preparing the file</p> : null}
      {phase.status === "done" ? <p role="status" className="mt-2 break-words text-xs font-semibold">Downloaded {phase.filename}</p> : null}
      {phase.status === "error" ? (
        <p role="alert" className="mt-2 text-xs font-semibold">
          {phase.error.text}
          {phase.error.retryable ? (
            <button type="button" onClick={onRetry} className="ml-2 underline">
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
};

/**
 * The whole Costs tab as a function of a snapshot: the same markup in the browser and in the behavior scenarios,
 * which read this render to see what a member would see.
 */
export const CostsPanelView: FC<{
  snapshot: CostsSnapshot;
  labels: CostsLabels;
  handlers: CostsHandlers;
}> = ({ snapshot, labels, handlers }) => {
  const channelName = snapshot.channelId === null ? null : labels.channelName(snapshot.channelId);
  const basis = (
    <p className={`px-1 text-xs ${MUTED}`} data-testid="cost-basis">
      {COST_BASIS_COPY}
    </p>
  );

  if (snapshot.drilldown) {
    return (
      <div className="space-y-3" data-testid="costs-panel">
        <TurnDrilldown phase={snapshot.drilldown} labels={labels} onClose={handlers.onCloseDrilldown} onRetry={handlers.onOpenTurn} />
        {basis}
      </div>
    );
  }
  if (snapshot.messageFocus) {
    return (
      <div className="space-y-3" data-testid="costs-panel">
        <MessageTurns focus={snapshot.messageFocus} labels={labels} onOpenTurn={handlers.onOpenTurn} onClose={handlers.onCloseMessageFocus} />
        {basis}
      </div>
    );
  }

  const inChannel = snapshot.scope === "channel" && snapshot.channelId !== null;
  const phase = inChannel ? snapshot.channel : snapshot.organization;
  let body: ReactNode = null;
  if (phase.status === "idle" || phase.status === "loading") {
    body = <Loading label="Loading costs" />;
  } else if (phase.status === "error") {
    body = <CostsErrorNotice error={phase.error} onRetry={handlers.onRetry} />;
  } else if (inChannel && snapshot.channel.status === "ready") {
    const value = snapshot.channel.value;
    body = (
      <>
        <CostHeadline totals={value.totals} title={channelName ?? "This conversation"} emptyText="No model spend recorded for this conversation yet." />
        {value.totals.rows > 0 ? (
          <>
            <Breakdown kind="bot" title="By bot" lines={breakdownLines(value.bots, "bot", labels.botName)} />
            <Breakdown kind="model" title="By model" lines={modelLines(value.totals)} />
            <TurnsList
              title="Turns"
              page={value.turns}
              total={value.totals}
              labels={labels}
              onOpenTurn={handlers.onOpenTurn}
              onLoadMore={handlers.onLoadMoreTurns}
            />
            <ExportBar snapshot={snapshot} onExport={handlers.onExport} onRetry={() => handlers.onExport("turn")} />
          </>
        ) : null}
      </>
    );
  } else if (snapshot.organization.status === "ready") {
    const value = snapshot.organization.value;
    body = (
      <>
        <CostHeadline totals={value.totals} title="Organization" emptyText={`No model spend recorded for ${monthLabel(snapshot.month)}.`} />
        {value.totals.rows > 0 ? (
          <>
            <Breakdown
              kind="bot"
              title="By bot"
              lines={breakdownLines(value.bots.groups, "bot", labels.botName)}
              more={{ page: value.bots, onMore: () => handlers.onLoadMoreGroups("bot") }}
            />
            <Breakdown
              kind="channel"
              title="By conversation"
              lines={breakdownLines(value.channels.groups, "channel", labels.channelName)}
              more={{ page: value.channels, onMore: () => handlers.onLoadMoreGroups("channel") }}
            />
            <Breakdown kind="model" title="By model" lines={modelLines(value.totals)} />
            <TurnsList
              title="Recent turns"
              page={value.turns}
              total={value.totals}
              labels={labels}
              onOpenTurn={handlers.onOpenTurn}
              onLoadMore={handlers.onLoadMoreTurns}
            />
            <ExportBar snapshot={snapshot} onExport={handlers.onExport} onRetry={() => handlers.onExport("turn")} />
          </>
        ) : null}
      </>
    );
  }

  return (
    <div className="space-y-3" data-testid="costs-panel">
      <ScopeSwitch scope={inChannel ? "channel" : "organization"} channelName={channelName} onSetScope={handlers.onSetScope} />
      {inChannel ? null : (
        <MonthBar
          month={snapshot.month}
          canGoToPreviousMonth={snapshot.canGoToPreviousMonth}
          canGoToNextMonth={snapshot.canGoToNextMonth}
          onPreviousMonth={handlers.onPreviousMonth}
          onNextMonth={handlers.onNextMonth}
        />
      )}
      {body}
      {basis}
    </div>
  );
};
