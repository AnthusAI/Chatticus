import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";
import { orgApiPath } from "./paths";
import type { ActiveOrg } from "./membership-state";
import type { OverlayEntry } from "./computer-files-overlay";
import {
  CONTENT_RANGE_BYTES,
  FilesApiError,
  filesQuery,
  type DirectoryCreateResult,
  type FileContentRange,
  type FileDeleteResult,
  type FileListing,
  type FileMoveResult,
  type FileStat,
  type FileWatchState,
  type FileWriteResult,
} from "./computer-files";

async function readFilesJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code: string | null = null;
    let message = `HTTP ${response.status}`;
    let currentSha256: string | null = null;
    let retryAfterMs: number | null = null;
    let keptAs: string | null = null;
    try {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
        current_sha256?: unknown;
        retry_after_ms?: unknown;
        kept_as?: unknown;
      };
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string") message = body.message;
      if (typeof body.current_sha256 === "string") currentSha256 = body.current_sha256;
      if (typeof body.retry_after_ms === "number") retryAfterMs = body.retry_after_ms;
      if (typeof body.kept_as === "string") keptAs = body.kept_as;
    } catch {
      message = `HTTP ${response.status}`;
    }
    if (retryAfterMs === null) {
      const header = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(header) && header > 0) retryAfterMs = Math.round(header * 1000);
    }
    throw new FilesApiError(response.status, code, message, { currentSha256, retryAfterMs, keptAs });
  }
  return (await response.json()) as T;
}

function filesUrl(org: ActiveOrg, suffix: string): string {
  return `${apiBase}${orgApiPath(org.tenantId, `/computer/files${suffix}`)}`;
}

/** A strong quoted validator, as If-Match wants it. */
export function quotedEtag(sha256: string): string {
  return `"${sha256}"`;
}

/** The hash inside an ETag header value, or null when there is none. */
export function sha256FromEtag(value: string | null): string | null {
  if (value === null) return null;
  const match = /^"([0-9a-f]{64})"$/.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Lists one directory of the organization's computer: the live computer when
 * it answers, the saved copy (with the changes waiting for the computer merged
 * in) when it is off or cannot be reached.
 */
export async function listComputerFiles(org: ActiveOrg, path: string): Promise<FileListing> {
  const response = await fetch(filesUrl(org, `?${filesQuery(path)}`), { headers: await authorizedHeaders() });
  return readFilesJson<FileListing>(response);
}

/** Reads one byte range of a file; `variant: "mine"` reads the person's version of a conflicting change. */
export async function readComputerFileRange(
  org: ActiveOrg,
  path: string,
  offset = 0,
  length = CONTENT_RANGE_BYTES,
  variant?: "mine",
): Promise<FileContentRange> {
  const query = new URLSearchParams(filesQuery(path, { offset, length }));
  if (variant) query.set("variant", variant);
  const response = await fetch(filesUrl(org, `/content?${query.toString()}`), { headers: await authorizedHeaders() });
  return readFilesJson<FileContentRange>(response);
}

/** One entry as it is, with the hash a delete or a rename must send (the ETag; a folder's is its tree hash). */
export async function statComputerFile(
  org: ActiveOrg,
  path: string,
): Promise<{ stat: FileStat; etagSha256: string | null }> {
  const response = await fetch(filesUrl(org, `/stat?${filesQuery(path)}`), { headers: await authorizedHeaders() });
  const etagSha256 = sha256FromEtag(response.headers.get("ETag"));
  return { stat: await readFilesJson<FileStat>(response), etagSha256 };
}

export type WritePrecondition = { type: "if_match"; sha256: string } | { type: "if_none_match" };

/**
 * Saves the whole text of a file. An existing file needs the hash it was read
 * at (If-Match); a new file needs If-None-Match: *. The server answers 409
 * precondition_failed when the file changed.
 */
export async function writeComputerFile(
  org: ActiveOrg,
  path: string,
  content: string,
  precondition: WritePrecondition,
): Promise<FileWriteResult> {
  const preconditionHeader: Record<string, string> =
    precondition.type === "if_match" ? { "If-Match": quotedEtag(precondition.sha256) } : { "If-None-Match": "*" };
  const response = await fetch(filesUrl(org, `/content?${filesQuery(path)}`), {
    method: "PUT",
    headers: { ...(await authorizedHeaders()), "Content-Type": "application/json", ...preconditionHeader },
    body: JSON.stringify({ content }),
  });
  return readFilesJson<FileWriteResult>(response);
}

/** Shows a masked file; the server records who and when. */
export async function revealComputerFile(org: ActiveOrg, path: string): Promise<FileContentRange> {
  const response = await fetch(filesUrl(org, "/reveal"), {
    method: "POST",
    headers: { ...(await authorizedHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return readFilesJson<FileContentRange>(response);
}

/** Tells the control plane the Files panel is open or closed. Starts nothing. */
export async function watchComputerFiles(org: ActiveOrg, open: boolean, closing = false): Promise<FileWatchState> {
  const response = await fetch(filesUrl(org, "/watch"), {
    method: "POST",
    headers: { ...(await authorizedHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ open }),
    keepalive: closing,
  });
  return readFilesJson<FileWatchState>(response);
}

/** Deletes a file, a link or a folder; `ifMatchSha256` is the hash from a stat. A non-empty folder needs `recursive` and the owner role. */
export async function deleteComputerEntry(
  org: ActiveOrg,
  path: string,
  ifMatchSha256: string,
  recursive: boolean,
): Promise<FileDeleteResult> {
  const query = new URLSearchParams(filesQuery(path));
  if (recursive) query.set("recursive", "true");
  const response = await fetch(filesUrl(org, `?${query.toString()}`), {
    method: "DELETE",
    headers: { ...(await authorizedHeaders()), "If-Match": quotedEtag(ifMatchSha256) },
  });
  return readFilesJson<FileDeleteResult>(response);
}

/** Renames a file, a link or a folder; it never replaces an existing path. */
export async function moveComputerEntry(
  org: ActiveOrg,
  from: string,
  to: string,
  ifMatchSha256: string,
): Promise<FileMoveResult> {
  const response = await fetch(filesUrl(org, "/move"), {
    method: "POST",
    headers: { ...(await authorizedHeaders()), "Content-Type": "application/json", "If-Match": quotedEtag(ifMatchSha256) },
    body: JSON.stringify({ from, to }),
  });
  return readFilesJson<FileMoveResult>(response);
}

/** Creates a folder; asking again for one that exists is not an error. */
export async function createComputerDirectory(org: ActiveOrg, path: string): Promise<DirectoryCreateResult> {
  const response = await fetch(filesUrl(org, "/directories"), {
    method: "POST",
    headers: { ...(await authorizedHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return readFilesJson<DirectoryCreateResult>(response);
}

/** The changes waiting for the computer to start. */
export async function listPendingChanges(org: ActiveOrg): Promise<OverlayEntry[]> {
  const response = await fetch(filesUrl(org, "/overlay"), { headers: await authorizedHeaders() });
  const body = await readFilesJson<{ entries: OverlayEntry[] }>(response);
  return body.entries;
}

/** Drops one change waiting for the computer; any enabled member may. */
export async function discardPendingChange(org: ActiveOrg, path: string, revision: number): Promise<void> {
  const response = await fetch(filesUrl(org, "/overlay/discard"), {
    method: "POST",
    headers: { ...(await authorizedHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ path, revision }),
  });
  await readFilesJson<{ discarded: boolean }>(response);
}

/** The routes the panel's controller uses, bound to one organization. */
export type ComputerFilesApi = {
  list: (path: string) => Promise<FileListing>;
  read: (path: string, offset?: number, length?: number, variant?: "mine") => Promise<FileContentRange>;
  stat: (path: string) => Promise<{ stat: FileStat; etagSha256: string | null }>;
  write: (path: string, content: string, precondition: WritePrecondition) => Promise<FileWriteResult>;
  reveal: (path: string) => Promise<FileContentRange>;
  watch: (open: boolean, closing?: boolean) => Promise<FileWatchState>;
  remove: (path: string, ifMatchSha256: string, recursive: boolean) => Promise<FileDeleteResult>;
  move: (from: string, to: string, ifMatchSha256: string) => Promise<FileMoveResult>;
  makeDirectory: (path: string) => Promise<DirectoryCreateResult>;
  pending: () => Promise<OverlayEntry[]>;
  discard: (path: string, revision: number) => Promise<void>;
};

/** The file routes of one organization. */
export function computerFilesApiFor(org: ActiveOrg): ComputerFilesApi {
  return {
    list: (path) => listComputerFiles(org, path),
    read: (path, offset, length, variant) => readComputerFileRange(org, path, offset, length, variant),
    stat: (path) => statComputerFile(org, path),
    write: (path, content, precondition) => writeComputerFile(org, path, content, precondition),
    reveal: (path) => revealComputerFile(org, path),
    watch: (open, closing) => watchComputerFiles(org, open, closing),
    remove: (path, ifMatchSha256, recursive) => deleteComputerEntry(org, path, ifMatchSha256, recursive),
    move: (from, to, ifMatchSha256) => moveComputerEntry(org, from, to, ifMatchSha256),
    makeDirectory: (path) => createComputerDirectory(org, path),
    pending: () => listPendingChanges(org),
    discard: (path, revision) => discardPendingChange(org, path, revision),
  };
}
