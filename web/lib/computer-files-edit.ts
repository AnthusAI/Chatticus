/**
 * Pure state for editing one text file in the panel: the draft, the hash it
 * was loaded at (the If-Match of the save), what a save answered, and what to
 * do about each way a save can fail. Nothing here touches the network.
 */

import {
  FilesApiError,
  describeFilesError,
  type FileContentRange,
  type FileWriteResult,
  type FilesErrorView,
} from "./computer-files";

export const EDIT_MAX_BYTES = 262144;
export const SAVE_AUTO_RETRY_LIMIT = 3;
export const TOO_LARGE_TO_EDIT_MESSAGE = "This file is too large to edit here";

export type EditNotice =
  | { kind: "saving" }
  | { kind: "error"; view: FilesErrorView; code: string | null; attempt: number }
  | { kind: "info"; text: string };

export type EditSession = {
  path: string;
  /** The effective hash the draft started from; null for a file that does not exist yet. */
  loadedSha256: string | null;
  loadedText: string;
  loadedSize: number;
  loadedModifiedAt: string | null;
  loadedFromLive: boolean;
  draft: string;
  phase: "editing" | "saving";
  notice: EditNotice | null;
  autoRetries: number;
  piChanged: boolean;
};

export type SaveMessage = { headline: string; detail: string | null; keptAsNotice: string | null };

/** Starts editing the whole text of a file that was read as one range. */
export function startEditSession(range: Pick<FileContentRange, "path" | "sha256" | "content" | "size" | "modified_at" | "source">): EditSession {
  return {
    path: range.path,
    loadedSha256: range.sha256,
    loadedText: range.content,
    loadedSize: range.size,
    loadedModifiedAt: range.modified_at,
    loadedFromLive: range.source === "live",
    draft: range.content,
    phase: "editing",
    notice: null,
    autoRetries: 0,
    piChanged: false,
  };
}

/** Starts editing a file that was just created empty. */
export function startNewFileSession(path: string, sha256: string, modifiedAt: string | null, fromLive: boolean): EditSession {
  return {
    path,
    loadedSha256: sha256,
    loadedText: "",
    loadedSize: 0,
    loadedModifiedAt: modifiedAt,
    loadedFromLive: fromLive,
    draft: "",
    phase: "editing",
    notice: null,
    autoRetries: 0,
    piChanged: false,
  };
}

/** Replaces the draft; a changed draft clears a stale failure notice. */
export function changeDraft(session: EditSession, draft: string): EditSession {
  if (draft === session.draft) return session;
  return { ...session, draft, notice: session.notice?.kind === "saving" ? session.notice : null };
}

/** True when the draft differs from the text that was loaded. */
export function draftIsChanged(session: EditSession): boolean {
  return session.draft !== session.loadedText;
}

/** The byte length of the draft as UTF-8. */
export function draftByteLength(draft: string): number {
  return new TextEncoder().encode(draft).length;
}

/** Why Save cannot be pressed now, or null when it can. */
export function saveBlockedReason(session: EditSession): string | null {
  if (session.phase === "saving") return "Saving";
  if (draftByteLength(session.draft) > EDIT_MAX_BYTES) return "This text is over 256 KiB, the most that can be saved here";
  if (session.draft.includes("\u0000")) return "Text with a NUL character cannot be saved";
  return null;
}

/** Marks the save as sent. */
export function beginSave(session: EditSession): EditSession {
  return { ...session, phase: "saving", notice: { kind: "saving" } };
}

/** The words for a save the server accepted. */
export function describeSaveSuccess(result: Pick<FileWriteResult, "source" | "backed_up" | "kept_as">): SaveMessage {
  const keptAsNotice = result.kept_as ? `A change made at the same moment was kept as ${nameOfPath(result.kept_as)}` : null;
  if (result.source === "overlay") {
    return { headline: "Saved. Your change will be applied when the computer starts", detail: null, keptAsNotice };
  }
  return {
    headline: "Saved on the computer",
    detail: result.backed_up ? null : "Not yet in the saved copy",
    keptAsNotice,
  };
}

function nameOfPath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

export type SaveFailure =
  | { kind: "conflict"; currentSha256: string | null; session: EditSession }
  | { kind: "kept"; session: EditSession; retryInMs: number | null };

/**
 * What a failed save does to the session. A 409 precondition_failed is the
 * conflict; every other failure keeps the draft, shows its wording, and, for
 * a computer that is starting or stopping, asks to be tried again by itself
 * three times before a button takes over.
 */
export function failSave(session: EditSession, error: unknown): SaveFailure {
  const editing: EditSession = { ...session, phase: "editing" };
  if (error instanceof FilesApiError && error.code === "precondition_failed") {
    return { kind: "conflict", currentSha256: error.currentSha256, session: { ...editing, notice: null } };
  }
  const view = describeFilesError(error);
  const code = error instanceof FilesApiError ? error.code : null;
  const wantsAuto = view.autoRetryAfterMs !== null && session.autoRetries < SAVE_AUTO_RETRY_LIMIT;
  const next: EditSession = {
    ...editing,
    autoRetries: wantsAuto ? session.autoRetries + 1 : session.autoRetries,
    notice: { kind: "error", view, code, attempt: session.autoRetries + 1 },
  };
  return { kind: "kept", session: next, retryInMs: wantsAuto ? view.autoRetryAfterMs : null };
}

/** The listing and viewer decide on the editor from the response alone. */
export type EditorOffer =
  | { offered: true }
  | { offered: false; reason: "too-large" | "not-editable" | "not-live-enough" | "not-text" };

/**
 * Whether the Edit button is shown for a file read as one range. A stale
 * answer (the live computer could not be reached) never offers it; a file
 * over 256 KiB, or one that came back truncated, says so instead.
 */
export function offerEditor(range: FileContentRange | null): EditorOffer {
  if (range === null) return { offered: false, reason: "not-editable" };
  if (range.masked && !range.revealed) return { offered: false, reason: "not-editable" };
  if (range.binary || range.encoding !== "utf8") return { offered: false, reason: "not-text" };
  if (range.truncated || range.size > EDIT_MAX_BYTES) return { offered: false, reason: "too-large" };
  if (range.stale || range.fallback_reason !== null) return { offered: false, reason: "not-live-enough" };
  if (!range.editable) return { offered: false, reason: "not-editable" };
  return { offered: true };
}

/** True when a probe stat shows the file changed since the editor loaded it. */
export function changedSinceLoad(
  session: Pick<EditSession, "loadedSize" | "loadedModifiedAt">,
  stat: { size: number | null; modified_at: string | null },
): boolean {
  return stat.size !== session.loadedSize || stat.modified_at !== session.loadedModifiedAt;
}
