import type { Message } from "./api";
import { toolCardsFromActivity } from "./committed-activity";
import { normalizeWorkspacePath } from "./computer-files";
import type { ToolCardModel } from "./turn-activity";

export type TouchAction = "wrote" | "edited" | "read";

export type TouchedFile = {
  path: string;
  action: TouchAction;
  /**
   * Identifies the latest write or edit call for the path and its status, so a
   * second write, or a running call that finishes, reads as a change. Null
   * when the path was only read.
   */
  lastWriteSignature: string | null;
};

export const TOUCHED_FILES_LIMIT = 50;

const ACTION_BY_TOOL: Record<string, TouchAction> = {
  write_workspace: "wrote",
  edit_workspace: "edited",
  read_workspace: "read",
};

const ACTION_STRENGTH: Record<TouchAction, number> = { wrote: 3, edited: 2, read: 1 };

/**
 * Distinct workspace paths the bot touched, newest first, each with its
 * strongest action (wrote over edited over read).
 *
 * Cards are given oldest to newest. Failed calls are ignored, as are tools
 * without a file path (run_terminal) and paths outside /workspace. Relative
 * paths count as relative to /workspace. At most 50 are returned. Each path
 * carries the signature of its latest write or edit call, which the panel
 * watches to warn that Pi changed the open file.
 */
export function collectTouchedFiles(cardsOldestFirst: readonly ToolCardModel[]): TouchedFile[] {
  const strongest = new Map<string, TouchAction>();
  const lastIndex = new Map<string, number>();
  const lastWrite = new Map<string, string>();
  cardsOldestFirst.forEach((card, index) => {
    const action = ACTION_BY_TOOL[card.tool];
    if (!action || card.status === "failed") return;
    const raw = card.arguments?.path;
    if (typeof raw !== "string") return;
    const path = normalizeWorkspacePath(raw);
    if (path === null) return;
    const known = strongest.get(path);
    if (known === undefined || ACTION_STRENGTH[action] > ACTION_STRENGTH[known]) {
      strongest.set(path, action);
    }
    lastIndex.set(path, index);
    if (action !== "read") lastWrite.set(path, `${card.callId}:${card.status}`);
  });
  return [...strongest.entries()]
    .sort((left, right) => (lastIndex.get(right[0]) ?? 0) - (lastIndex.get(left[0]) ?? 0))
    .slice(0, TOUCHED_FILES_LIMIT)
    .map(([path, action]) => ({ path, action, lastWriteSignature: lastWrite.get(path) ?? null }));
}

/**
 * Touched files from committed messages (by sequence) followed by the live
 * turn's cards, which are the newest.
 */
export function touchedFilesFromActivity(
  committedMessages: readonly Pick<Message, "seq" | "activity">[],
  liveCards: readonly ToolCardModel[],
): TouchedFile[] {
  const ordered = [...committedMessages].sort((left, right) => left.seq - right.seq);
  const committedCards = ordered.flatMap((message) => toolCardsFromActivity(message.activity));
  return collectTouchedFiles([...committedCards, ...liveCards]);
}

const ACTION_LABELS: Record<TouchAction, string> = { wrote: "Wrote", edited: "Edited", read: "Read" };

/** Text mark for an action. */
export function touchActionLabel(action: TouchAction): string {
  return ACTION_LABELS[action];
}
