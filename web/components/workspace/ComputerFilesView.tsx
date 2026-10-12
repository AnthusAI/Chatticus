import type { FC } from "react";

import {
  MASKED_FILE_MESSAGE,
  SAVED_COPY_NOTE,
  binaryFileLabel,
  buildBreadcrumbs,
  formatFileSize,
  shortenHash,
  type BreadcrumbSegment,
  type FilesErrorView,
  type ListingView,
} from "@/lib/computer-files";
import { touchActionLabel, type TouchedFile } from "@/lib/touched-files";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt";
const ROW_BUTTON =
  `flex min-h-11 w-full items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2 text-left text-xs hover:bg-surface-high ${FOCUS}`;
const SMALL_BUTTON =
  `inline-flex min-h-11 items-center justify-center rounded-full bg-surface-high px-4 text-xs font-bold text-surface-foreground hover:bg-surface-raised ${FOCUS}`;

/** Path bar from /workspace to the current folder or file. */
export const FilesBreadcrumb: FC<{
  path: string;
  onNavigate: (path: string) => void;
}> = ({ path, onNavigate }) => {
  const segments: BreadcrumbSegment[] = buildBreadcrumbs(path);
  return (
    <nav aria-label="File path">
      <ol className="flex flex-wrap items-center gap-x-1 font-mono text-xs">
        {segments.map((segment, index) => (
          <li key={segment.path} className="flex items-center gap-1">
            {index > 0 ? <span aria-hidden="true" className="opacity-60">/</span> : null}
            {segment.current ? (
              <span aria-current="page" className="font-bold">{segment.label}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(segment.path)}
                className={`min-h-11 rounded-lg px-1.5 hover:bg-surface-high ${FOCUS}`}
              >
                {segment.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
};

/** The "as of" line and the plain statement that this is not live. */
export const SavedCopyNote: FC<{ asOfText: string | null }> = ({ asOfText }) => (
  <p className="text-xs opacity-70" data-testid="saved-copy-note">
    {SAVED_COPY_NOTE}
    {asOfText ? `. ${asOfText}.` : "."}
  </p>
);

/** A directory listing; directories descend, files open the viewer. */
export const FilesListing: FC<{
  view: ListingView;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}> = ({ view, onOpenDirectory, onOpenFile }) => {
  if (view.empty) {
    return <p className="rounded-xl bg-surface p-4 text-xs opacity-70">This folder is empty</p>;
  }
  return (
    <div>
      <ul aria-label="Folder contents" className="grid gap-1.5">
        {view.rows.map((row) => (
          <li key={row.path}>
            <button
              type="button"
              onClick={() => (row.opensDirectory ? onOpenDirectory(row.path) : onOpenFile(row.path))}
              aria-label={`${row.kindLabel} ${row.name}${row.sizeLabel ? `, ${row.sizeLabel}` : ""}${row.linkTarget ? `, links to ${row.linkTarget}` : ""}`}
              className={ROW_BUTTON}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono font-semibold">
                  {row.name}
                  {row.opensDirectory ? "/" : ""}
                </span>
                {row.linkTarget ? (
                  <span className="block truncate font-mono opacity-70">links to {row.linkTarget}</span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[0.65rem] opacity-70">
                {row.sizeLabel ? <span>{row.sizeLabel}</span> : null}
                <span className="uppercase">{row.kindLabel}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {view.truncatedNote ? <p className="mt-2 text-xs opacity-70">{view.truncatedNote}</p> : null}
    </div>
  );
};

/** Files the bot read, wrote or edited in the recent turns, newest first. */
export const TouchedFilesList: FC<{
  files: readonly TouchedFile[];
  onOpen: (path: string) => void;
}> = ({ files, onOpen }) => (
  <section aria-labelledby="touched-files-heading" className="rounded-2xl bg-surface p-3">
    <h4 id="touched-files-heading" className="text-xs font-extrabold uppercase tracking-wide">
      Files Pi touched
    </h4>
    {files.length === 0 ? (
      <p className="mt-2 text-xs opacity-70">No files read or changed in recent turns.</p>
    ) : (
      <ul aria-label="Files Pi touched" className="mt-2 grid max-h-44 gap-1 overflow-y-auto">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onOpen(file.path)}
              aria-label={`${touchActionLabel(file.action)} ${file.path}`}
              className={`flex min-h-11 w-full items-center gap-3 rounded-xl bg-surface-raised px-3 py-2 text-left text-xs hover:bg-surface-high ${FOCUS}`}
            >
              <span className="w-12 shrink-0 font-mono text-[0.65rem] uppercase opacity-70">
                {touchActionLabel(file.action)}
              </span>
              <span className="min-w-0 truncate font-mono">{file.path}</span>
            </button>
          </li>
        ))}
      </ul>
    )}
  </section>
);

/** An empty, notice or error state with an optional retry. */
export const FilesNotice: FC<{
  view: FilesErrorView;
  onRetry?: () => void;
}> = ({ view, onRetry }) => (
  <div
    role={view.tone === "error" ? "alert" : "status"}
    className="rounded-xl bg-surface p-4 text-xs"
  >
    <p className={view.tone === "error" ? "font-semibold" : ""}>{view.title}</p>
    {view.retryable && onRetry ? (
      <button type="button" onClick={onRetry} className={`mt-3 ${SMALL_BUTTON}`}>
        Try again
      </button>
    ) : null}
  </div>
);

export const FilesLoading: FC<{ label: string }> = ({ label }) => (
  <p role="status" aria-live="polite" className="rounded-xl bg-surface p-4 text-xs opacity-70">
    {label}
  </p>
);

export type FileViewerBody =
  | { kind: "masked" }
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; mime: string }
  | { kind: "binary"; size: number };

/** The viewer for one file: text as escaped monospace, images from a Blob URL, else a plain note. */
export const FileViewer: FC<{
  name: string;
  body: FileViewerBody;
  size: number;
  sha256: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadedBytes: number;
  copied: boolean;
  onLoadMore: () => void;
  onCopy: () => void;
}> = ({ name, body, size, sha256, hasMore, loadingMore, loadedBytes, copied, onLoadMore, onCopy }) => (
  <section aria-label={`File ${name}`} className="rounded-2xl bg-surface p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 truncate font-mono text-xs font-bold">{name}</p>
      <p className="font-mono text-[0.65rem] opacity-70">
        {formatFileSize(size)}
        {sha256 ? (
          <>
            {" "}
            <span title={sha256} data-testid="file-sha256">sha256 {shortenHash(sha256)}</span>
          </>
        ) : null}
      </p>
    </div>
    <div className="mt-2">
      {body.kind === "masked" ? (
        <p role="status" className="rounded-xl bg-surface-raised p-3 text-xs">{MASKED_FILE_MESSAGE}</p>
      ) : null}
      {body.kind === "binary" ? (
        <p role="status" className="rounded-xl bg-surface-raised p-3 text-xs">{binaryFileLabel(body.size)}</p>
      ) : null}
      {body.kind === "image" ? (
        <div className="max-h-80 overflow-auto rounded-xl bg-surface-raised p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={body.url} alt={`Preview of ${name}`} className="max-w-full" />
        </div>
      ) : null}
      {body.kind === "text" ? (
        <>
          <pre
            tabIndex={0}
            aria-label={`Contents of ${name}`}
            className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-raised px-3 py-2 font-mono text-xs leading-5 ${FOCUS}`}
          >
            {body.text === "" ? "(empty file)" : body.text}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onCopy}
              aria-label={hasMore ? `Copy loaded text of ${name}` : `Copy text of ${name}`}
              className={SMALL_BUTTON}
            >
              Copy
            </button>
            <span role="status" aria-live="polite" className="text-xs opacity-70">
              {copied ? "Copied" : ""}
            </span>
          </div>
        </>
      ) : null}
    </div>
    {hasMore ? (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onLoadMore} disabled={loadingMore} className={`${SMALL_BUTTON} disabled:opacity-50`}>
          {loadingMore ? "Loading" : "Load more"}
        </button>
        <span className="text-xs opacity-70">
          Showing {formatFileSize(loadedBytes) || "0 B"} of {formatFileSize(size)}
        </span>
      </div>
    ) : null}
  </section>
);
