import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";
import { orgApiPath } from "./paths";
import type { ActiveOrg } from "./membership-state";
import {
  CONTENT_RANGE_BYTES,
  FilesApiError,
  filesQuery,
  type FileContentRange,
  type FileListing,
} from "./computer-files";

async function readFilesJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code: string | null = null;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string") message = body.message;
    } catch {
      message = `HTTP ${response.status}`;
    }
    throw new FilesApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

/** Lists one directory of the saved copy of the organization's computer. Read-only. */
export async function listComputerFiles(org: ActiveOrg, path: string): Promise<FileListing> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/computer/files?${filesQuery(path)}`)}`,
    { headers: await authorizedHeaders() },
  );
  return readFilesJson<FileListing>(response);
}

/** Reads one byte range of a file in the saved copy. Read-only. */
export async function readComputerFileRange(
  org: ActiveOrg,
  path: string,
  offset = 0,
  length = CONTENT_RANGE_BYTES,
): Promise<FileContentRange> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/computer/files/content?${filesQuery(path, { offset, length })}`)}`,
    { headers: await authorizedHeaders() },
  );
  return readFilesJson<FileContentRange>(response);
}
