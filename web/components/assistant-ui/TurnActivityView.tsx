import type { FC } from "react";

import {
  formatToolDuration,
  presentToolArguments,
  type ToolCardModel,
  type TurnActivity,
} from "@/lib/turn-activity";
import { cn } from "@/lib/utils";

const CODE_BLOCK_CLASS =
  "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-raised px-3 py-2 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25";

const BlockLabel: FC<{ children: string }> = ({ children }) => (
  <p className="mb-1 mt-2 text-[0.68rem] font-semibold uppercase tracking-wide text-surface-foreground/55">
    {children}
  </p>
);

const CodeBlock: FC<{ label: string; text: string }> = ({ label, text }) => (
  <pre tabIndex={0} aria-label={label} className={CODE_BLOCK_CLASS}>
    {text}
  </pre>
);

/** Calm "Working" state with the current phase; static text under reduced motion. */
export const WorkingIndicator: FC<{ phaseText: string | null }> = ({ phaseText }) => (
  <p
    role="status"
    aria-live="polite"
    data-testid="turn-working-indicator"
    className="flex items-center gap-2 text-surface-foreground/65"
  >
    <span className="flex shrink-0 gap-1" aria-hidden="true">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="h-1.5 w-1.5 rounded-full bg-surface-foreground opacity-60 motion-safe:animate-pulse"
          style={{ animationDelay: `${dot * 180}ms` }}
        />
      ))}
    </span>
    <span>Working</span>
    {phaseText ? <span className="text-surface-foreground/45">{phaseText}</span> : null}
  </p>
);

export const ThinkingBlock: FC<{ text: string }> = ({ text }) => (
  <details className="rounded-2xl bg-surface px-3 py-2 text-xs text-surface-foreground/65">
    <summary className="cursor-pointer select-none font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25">
      Thinking
    </summary>
    <p className="mt-2 whitespace-pre-wrap leading-5">{text}</p>
  </details>
);

const STATUS_TEXT = { running: "Running", ok: "Done", failed: "Failed" } as const;

const ToolCardDetails: FC<{ card: ToolCardModel }> = ({ card }) => {
  const shown = presentToolArguments(card.kind, card.arguments);
  const hasArguments =
    shown !== null &&
    (shown.command !== null ||
      shown.path !== null ||
      shown.oldText !== null ||
      shown.newText !== null ||
      shown.preview !== null ||
      shown.other.length > 0);
  if (!hasArguments && card.output === null) {
    return <p className="mt-2 text-surface-foreground/55">No further details were reported.</p>;
  }
  return (
    <div className="mt-1">
      {shown && hasArguments ? (
        <>
          <BlockLabel>Arguments</BlockLabel>
          {shown.command !== null ? <CodeBlock label="Command" text={shown.command} /> : null}
          {shown.path !== null ? (
            <p className="mb-1 break-all font-mono text-xs">{shown.path}</p>
          ) : null}
          {shown.oldText !== null ? (
            <>
              <BlockLabel>Before</BlockLabel>
              <CodeBlock label="Replaced text" text={shown.oldText} />
            </>
          ) : null}
          {shown.newText !== null ? (
            <>
              <BlockLabel>After</BlockLabel>
              <CodeBlock label="New text" text={shown.newText} />
            </>
          ) : null}
          {shown.preview !== null ? <CodeBlock label="Content preview" text={shown.preview} /> : null}
          {shown.other.map(([key, value]) => (
            <p key={key} className="break-all font-mono text-xs">
              <span className="text-surface-foreground/55">{key}: </span>
              {value}
            </p>
          ))}
          {card.argumentsTruncated ? (
            <p className="mt-1 text-surface-foreground/55">Arguments truncated.</p>
          ) : null}
        </>
      ) : null}
      {card.output !== null ? (
        <>
          <BlockLabel>{card.status === "failed" ? "Error output" : "Output"}</BlockLabel>
          <CodeBlock label={`${card.label} output`} text={card.output} />
          {card.outputTruncated ? (
            <p className="mt-1 text-surface-foreground/55">Output truncated.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

export const ToolCard: FC<{ card: ToolCardModel }> = ({ card }) => {
  const duration = formatToolDuration(card.durationMs);
  return (
    <li data-testid="tool-card" data-status={card.status}>
      <details
        open={card.openByDefault}
        className="rounded-2xl bg-surface px-3 py-2 text-xs"
      >
        <summary className="flex cursor-pointer select-none flex-wrap items-baseline gap-x-2 gap-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25">
          <span className="font-semibold">{card.label}</span>
          {card.summary ? (
            <span
              className={cn(
                "min-w-0 flex-1 break-words",
                card.status === "failed" ? "text-clay" : "text-surface-foreground/65",
              )}
            >
              {card.summary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span
            className={cn(
              "shrink-0 font-semibold",
              card.status === "failed" ? "text-clay" : "text-surface-foreground/55",
              card.status === "running" && "motion-safe:animate-pulse",
            )}
          >
            {STATUS_TEXT[card.status]}
          </span>
          {duration ? (
            <span className="shrink-0 font-mono text-[0.65rem] text-surface-foreground/45">{duration}</span>
          ) : null}
        </summary>
        <ToolCardDetails card={card} />
      </details>
    </li>
  );
};

/** Thinking block and tool cards for a live turn, in order, above the answer. */
export const TurnActivityBody: FC<{ activity: TurnActivity }> = ({ activity }) => {
  if (!activity.hasActivity) {
    return null;
  }
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-testid="turn-activity">
      {activity.thinking ? <ThinkingBlock text={activity.thinking} /> : null}
      {activity.tools.length > 0 ? (
        <ul aria-label="Tool calls" className="flex flex-col gap-1">
          {activity.tools.map((card) => (
            <ToolCard key={card.callId} card={card} />
          ))}
        </ul>
      ) : null}
    </div>
  );
};
