import type { TurnEvent } from "./protocol";

export type ToolCardStatus = "running" | "ok" | "failed" | "unrecorded";

export type ToolCardKind = "command" | "write" | "edit" | "generic" | "more";

export type ToolCardModel = {
  callId: string;
  tool: string;
  label: string;
  kind: ToolCardKind;
  summary: string | null;
  status: ToolCardStatus;
  durationMs: number | null;
  arguments: Record<string, unknown> | null;
  argumentsTruncated: boolean;
  output: string | null;
  outputTruncated: boolean;
  openByDefault: boolean;
};

export type ActivityPhase =
  | "idle"
  | "thinking"
  | "tool"
  | "starting-computer"
  | "computer-ready"
  | "waiting"
  | "answering"
  | "done"
  | "failed";

export type TurnActivity = {
  phase: ActivityPhase;
  /** Calm one-line status for the working indicator, or null when none applies. */
  phaseText: string | null;
  /** True from turn start until the first answer token or the end of the turn. */
  showWorkingIndicator: boolean;
  thinking: string | null;
  tools: ToolCardModel[];
  hasActivity: boolean;
};

export const EMPTY_TURN_ACTIVITY: TurnActivity = {
  phase: "idle",
  phaseText: null,
  showWorkingIndicator: false,
  thinking: null,
  tools: [],
  hasActivity: false,
};

const TOOL_LABELS: ReadonlyArray<readonly [ReadonlySet<string>, string, ToolCardKind]> = [
  [new Set(["run_terminal"]), "Terminal", "command"],
  [new Set(["read_workspace"]), "Read file", "generic"],
  [new Set(["write_workspace"]), "Write file", "write"],
  [new Set(["edit_workspace"]), "Edit file", "edit"],
  [new Set(["browse"]), "Browse", "generic"],
  [new Set(["more"]), "More tool calls", "more"],
];

/** Plain label and card kind for a tool name; unknown tools keep their own name. */
export function describeTool(tool: string): { label: string; kind: ToolCardKind } {
  for (const [names, label, kind] of TOOL_LABELS) {
    if (names.has(tool)) {
      return { label, kind };
    }
  }
  return { label: tool || "Tool", kind: "generic" };
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toolNameOf(event: TurnEvent): string {
  return nonEmpty(event.tool) ?? "";
}

type MutableCard = Omit<ToolCardModel, "openByDefault" | "label" | "kind"> & { resultSeen: boolean };

function newCard(callId: string, tool: string): MutableCard {
  return {
    callId,
    tool,
    summary: null,
    status: "running",
    durationMs: null,
    arguments: null,
    argumentsTruncated: false,
    output: null,
    outputTruncated: false,
    resultSeen: false,
  };
}

function isArgumentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finishCard(card: MutableCard): ToolCardModel {
  const { label, kind } = describeTool(card.tool);
  return {
    callId: card.callId,
    tool: card.tool,
    label,
    kind,
    summary: card.summary,
    status: card.status,
    durationMs: card.durationMs,
    arguments: card.arguments,
    argumentsTruncated: card.argumentsTruncated,
    output: card.output,
    outputTruncated: card.outputTruncated,
    openByDefault: card.status === "failed",
  };
}

/**
 * Derive everything the turn activity UI shows from the turn's event list.
 *
 * Pure: the same events always produce the same view model, so a stream
 * re-read from the start (reconnect, reload) rebuilds identical cards.
 * Events repeating an already-seen seq are ignored, so a replay overlapping
 * already-delivered events changes nothing.
 */
export function reduceTurnActivity(events: readonly TurnEvent[]): TurnActivity {
  const seenSeqs = new Set<number>();
  const cards = new Map<string, MutableCard>();
  const thinkingParts: string[] = [];
  let phase: ActivityPhase = "idle";
  let phaseTool = "";
  let waitingGate: string | null = null;
  let answerStarted = false;
  let ended = false;
  let anySeen = false;

  for (const event of events) {
    if (seenSeqs.has(event.seq)) {
      continue;
    }
    seenSeqs.add(event.seq);
    anySeen = true;
    const live = !ended && !answerStarted;

    switch (event.kind) {
      case "turn.started":
      case "attempt.claimed":
      case "model.request":
        if (live) {
          phase = "thinking";
        }
        break;
      case "turn.token":
        if (nonEmpty(event.token) !== null) {
          answerStarted = true;
          phase = "answering";
        }
        break;
      case "turn.thinking": {
        const text = nonEmpty(event.text);
        if (text !== null) {
          thinkingParts.push(text);
        }
        break;
      }
      case "tool.call": {
        const tool = toolNameOf(event);
        const callId = nonEmpty(event.call_id) ?? `seq:${event.seq}`;
        const card = cards.get(callId) ?? newCard(callId, tool);
        card.tool = card.tool || tool;
        card.summary = nonEmpty(event.summary) ?? card.summary;
        if (isArgumentObject(event.arguments)) {
          card.arguments = event.arguments;
        }
        card.argumentsTruncated = event.arguments_truncated === true || card.argumentsTruncated;
        cards.set(callId, card);
        if (live) {
          phase = "tool";
          phaseTool = card.tool;
        }
        break;
      }
      case "tool.result": {
        const tool = toolNameOf(event);
        let callId = nonEmpty(event.call_id);
        if (callId === null) {
          const running = [...cards.values()]
            .reverse()
            .find((candidate) => !candidate.resultSeen && (tool === "" || candidate.tool === tool));
          callId = running?.callId ?? `seq:${event.seq}`;
        }
        const card = cards.get(callId) ?? newCard(callId, tool);
        card.tool = card.tool || tool;
        card.resultSeen = true;
        card.status = event.ok === false ? "failed" : "ok";
        card.summary = card.status === "failed"
          ? nonEmpty(event.summary) ?? card.summary
          : card.summary ?? nonEmpty(event.summary);
        card.durationMs = typeof event.duration_ms === "number" ? event.duration_ms : card.durationMs;
        card.output = typeof event.output === "string" ? event.output : card.output;
        card.outputTruncated = event.output_truncated === true || card.outputTruncated;
        cards.set(callId, card);
        if (live) {
          phase = "thinking";
        }
        break;
      }
      case "turn.waiting": {
        if (live && phase !== "starting-computer") {
          phase = "waiting";
          waitingGate = nonEmpty(event.body);
        }
        break;
      }
      case "computer.starting":
        if (live) {
          phase = "starting-computer";
        }
        break;
      case "computer.ready":
        if (live) {
          phase = "computer-ready";
        }
        break;
      case "turn.completed":
        ended = true;
        phase = "done";
        break;
      case "turn.failed":
        ended = true;
        phase = "failed";
        break;
      case "turn.reconciling":
        ended = true;
        break;
      default:
        break;
    }
  }

  const tools = [...cards.values()].map(finishCard);
  const thinking = thinkingParts.length > 0 ? thinkingParts.join("\n\n") : null;

  return {
    phase,
    phaseText: phaseTextFor(phase, phaseTool, waitingGate),
    showWorkingIndicator: anySeen && !ended && !answerStarted,
    thinking,
    tools,
    hasActivity: tools.length > 0 || thinking !== null,
  };
}

function phaseTextFor(phase: ActivityPhase, tool: string, gate: string | null): string | null {
  switch (phase) {
    case "thinking":
      return "Thinking";
    case "tool":
      return tool ? `Using ${describeTool(tool).label.toLowerCase()}` : "Working";
    case "starting-computer":
      return "Starting your computer";
    case "computer-ready":
      return "Computer ready";
    case "waiting":
      return gate ? `Waiting for ${gate}` : "Waiting";
    default:
      return null;
  }
}

/** "1.2 s" or "340 ms" for a tool duration, or null when unknown. */
export function formatToolDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

export type ToolCardArguments = {
  command: string | null;
  path: string | null;
  oldText: string | null;
  newText: string | null;
  preview: string | null;
  other: Array<[string, string]>;
};

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Split sanitized tool arguments into the fields each card kind shows. */
export function presentToolArguments(
  kind: ToolCardKind,
  args: Record<string, unknown> | null,
): ToolCardArguments | null {
  if (args === null) return null;
  const used = new Set<string>();
  const pick = (keys: readonly string[]): string | null => {
    for (const key of keys) {
      const found = scalarText(args[key]);
      if (found !== null) {
        used.add(key);
        return found;
      }
    }
    return null;
  };
  const command = kind === "command" ? pick(["command"]) : null;
  const path = kind === "command" ? null : pick(["path", "url"]);
  const oldText = kind === "edit" ? pick(["old_text"]) : null;
  const newText = kind === "edit" ? pick(["new_text"]) : null;
  const preview = kind === "write" ? pick(["preview"]) : null;
  const other: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(args)) {
    if (used.has(key)) continue;
    const rendered = scalarText(value) ?? JSON.stringify(value);
    if (rendered !== undefined) other.push([key, rendered]);
  }
  return { command, path, oldText, newText, preview, other };
}
