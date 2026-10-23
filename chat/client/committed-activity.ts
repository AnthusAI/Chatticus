import type { Message, ToolActivityItem } from "./protocol";
import {
  describeTool,
  EMPTY_TURN_ACTIVITY,
  type ToolCardModel,
  type ToolCardStatus,
  type TurnActivity,
} from "./turn-activity";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isArgumentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cardFromActivityItem(item: ToolActivityItem, index: number): ToolCardModel {
  const tool = typeof item.tool === "string" ? item.tool : "";
  const { label, kind } = describeTool(tool);
  const status: ToolCardStatus = item.ok === true ? "ok" : item.ok === false ? "failed" : "unrecorded";
  const summary =
    status === "failed"
      ? stringOrNull(item.result_summary) ?? stringOrNull(item.summary)
      : stringOrNull(item.summary) ?? (status === "ok" ? stringOrNull(item.result_summary) : null);
  return {
    callId: stringOrNull(item.call_id) ?? `activity:${index}`,
    tool,
    label,
    kind,
    summary,
    status,
    durationMs: typeof item.duration_ms === "number" ? item.duration_ms : null,
    arguments: isArgumentObject(item.arguments) ? item.arguments : null,
    argumentsTruncated: item.arguments_truncated === true,
    output: typeof item.output === "string" ? item.output : null,
    outputTruncated: item.output_truncated === true,
    openByDefault: status === "failed",
  };
}

/**
 * Cards for the recorded tool calls of a committed message, in call order.
 *
 * Produces the same card model the live reducer does, so a card reads the
 * same during a turn and afterwards. Missing or malformed activity maps to
 * no cards.
 */
export function toolCardsFromActivity(
  activity: readonly ToolActivityItem[] | undefined | null,
): ToolCardModel[] {
  if (!Array.isArray(activity)) {
    return [];
  }
  return activity
    .filter((item) => typeof item === "object" && item !== null)
    .map(cardFromActivityItem);
}

/**
 * The activity a committed message shows.
 *
 * The server's recorded activity wins when present (an empty list is an
 * answer: no calls). When an older server sends no activity field, the cards
 * seen live for this same reply stay on screen. The live thinking summary is
 * kept either way because the server does not record it.
 */
export function committedMessageActivity(
  message: Pick<Message, "activity">,
  retained: TurnActivity | null,
): TurnActivity {
  const recorded = Array.isArray(message.activity) ? message.activity : null;
  const thinking = retained?.thinking ?? null;
  const tools = recorded !== null ? toolCardsFromActivity(recorded) : retained?.tools ?? [];
  return {
    ...EMPTY_TURN_ACTIVITY,
    phase: "done",
    thinking,
    tools,
    hasActivity: tools.length > 0 || thinking !== null,
  };
}

/** The activity of a just-ended live turn, kept so its reply keeps its cards. */
export type RetainedTurnActivity = {
  messageId: string;
  activity: TurnActivity;
};
