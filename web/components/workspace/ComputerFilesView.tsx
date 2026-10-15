import { useState, type FC, type FormEvent } from "react";

import {
  MASKED_FILE_MESSAGE,
  binaryFileLabel,
  buildBreadcrumbs,
  formatFileSize,
  shortenHash,
  type BreadcrumbSegment,
  type FilesErrorView,
  type ListingView,
  type SourceLine,
} from "@/lib/computer-files";
import type { ConflictView, PanelConfirm, StatusMessage, ViewerBody } from "@/lib/computer-files-controller";
import { TOO_LARGE_TO_EDIT_MESSAGE, type EditSession } from "@/lib/computer-files-edit";
import { describePendingChange, type OverlayEntry } from "@/lib/computer-files-overlay";
import { touchActionLabel, type TouchedFile } from "@/lib/touched-files";

export type { ViewerBody as FileViewerBody };

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

const SOURCE_DOT: Record<SourceLine["tone"], string> = {
  live: "bg-sea",
  saved: "bg-surface-high",
  trouble: "bg-amber",
  connecting: "bg-cobalt",
};

/** The one line that says where the files come from: live, a saved copy, or a fallback with a Retry. */
export const SourceLineView: FC<{ line: SourceLine; onRetry?: () => void }> = ({ line, onRetry }) => (
  <div className="flex flex-wrap items-center gap-2" data-testid="source-line">
    <p aria-live="polite" className="flex min-w-0 items-center gap-2 text-xs">
      <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${SOURCE_DOT[line.tone]}`} />
      <span>{line.text}</span>
    </p>
    {line.retryable && onRetry ? (
      <button type="button" onClick={onRetry} className={SMALL_BUTTON}>
        Retry
      </button>
    ) : null}
  </div>
);

/** One short result after a save, a delete or a rename, or the words for why a change failed. */
export const StatusLineView: FC<{ status: StatusMessage | null; onReload?: () => void; onRetry?: () => void }> = ({
  status,
  onReload,
  onRetry,
}) => (
  <div aria-live="polite" data-testid="status-line">
    {status ? (
      <div
        role={status.tone === "error" ? "alert" : undefined}
        className={`rounded-xl p-3 text-xs ${status.tone === "error" ? "bg-clay/15" : "bg-surface"}`}
      >
        <p className={status.tone === "error" ? "font-semibold" : ""}>{status.text}</p>
        {status.detail ? <p className="mt-1 opacity-70">{status.detail}</p> : null}
        {status.reloadInstead && onReload ? (
          <button type="button" onClick={onReload} className={`mt-2 ${SMALL_BUTTON}`}>
            Reload
          </button>
        ) : status.retryable && onRetry ? (
          <button type="button" onClick={onRetry} className={`mt-2 ${SMALL_BUTTON}`}>
            Retry
          </button>
        ) : null}
      </div>
    ) : null}
  </div>
);

/** A question with its answers. The safe answer takes focus. */
export const ConfirmBar: FC<{ confirm: PanelConfirm | null; onAnswer: (confirmed: boolean) => void }> = ({
  confirm,
  onAnswer,
}) =>
  confirm ? (
    <div role="alertdialog" aria-label={confirm.text} className="rounded-xl bg-surface-raised p-3 text-xs">
      <p className="font-semibold">{confirm.text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => onAnswer(false)} className={SMALL_BUTTON} autoFocus>
          {confirm.cancelLabel}
        </button>
        {confirm.confirmLabel ? (
          <button type="button" onClick={() => onAnswer(true)} className={SMALL_BUTTON}>
            {confirm.confirmLabel}
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

/** A one-line form: a name and a button. Used for new files, new folders and renames. */
export const NameForm: FC<{
  label: string;
  buttonLabel: string;
  initialValue?: string;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
}> = ({ label, buttonLabel, initialValue = "", onSubmit, onCancel }) => {
  const [value, setValue] = useState(initialValue);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(value);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
        <span className="shrink-0">{label}</span>
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={`min-h-11 min-w-0 flex-1 rounded-xl bg-surface-raised px-3 font-mono text-xs ${FOCUS}`}
        />
      </label>
      <button type="submit" className={SMALL_BUTTON}>
        {buttonLabel}
      </button>
      {onCancel ? (
        <button type="button" onClick={onCancel} className={SMALL_BUTTON}>
          Cancel
        </button>
      ) : null}
    </form>
  );
};

/** New file and New folder, and the way into the list of changes waiting for the computer. */
export const FilesToolbar: FC<{
  canChange: boolean;
  pendingCount: number;
  onNewFile: (name: string) => void;
  onNewFolder: (name: string) => void;
  onOpenPending: () => void;
}> = ({ canChange, pendingCount, onNewFile, onNewFolder, onOpenPending }) => {
  const [form, setForm] = useState<"file" | "folder" | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canChange ? (
          <>
            <button type="button" onClick={() => setForm(form === "file" ? null : "file")} className={SMALL_BUTTON}>
              New file
            </button>
            <button type="button" onClick={() => setForm(form === "folder" ? null : "folder")} className={SMALL_BUTTON}>
              New folder
            </button>
          </>
        ) : null}
        {pendingCount > 0 ? (
          <button type="button" onClick={onOpenPending} className={SMALL_BUTTON}>
            Pending changes ({pendingCount})
          </button>
        ) : null}
      </div>
      {form === "file" ? (
        <NameForm
          label="File name"
          buttonLabel="Create file"
          onSubmit={(name) => {
            setForm(null);
            onNewFile(name);
          }}
          onCancel={() => setForm(null)}
        />
      ) : null}
      {form === "folder" ? (
        <NameForm
          label="Folder name"
          buttonLabel="Create folder"
          onSubmit={(name) => {
            setForm(null);
            onNewFolder(name);
          }}
          onCancel={() => setForm(null)}
        />
      ) : null}
    </div>
  );
};

/** Everything waiting for the computer, one line each, with a Discard. */
export const PendingChangesList: FC<{
  entries: readonly OverlayEntry[];
  onDiscard: (path: string) => void;
  onClose: () => void;
}> = ({ entries, onDiscard, onClose }) => (
  <section aria-labelledby="pending-changes-heading" className="rounded-2xl bg-surface-raised p-3">
    <div className="flex items-center justify-between gap-2">
      <h4 id="pending-changes-heading" className="text-xs font-extrabold uppercase tracking-wide">
        Pending changes
      </h4>
      <button type="button" onClick={onClose} className={SMALL_BUTTON}>
        Close
      </button>
    </div>
    <p className="mt-1 text-xs opacity-70">These are applied when the computer starts.</p>
    {entries.length === 0 ? (
      <p className="mt-2 text-xs">Nothing is waiting for the computer.</p>
    ) : (
      <ul aria-label="Pending changes" className="mt-2 grid gap-1.5">
        {entries.map((entry) => {
          const description = describePendingChange(entry);
          return (
            <li key={entry.path} className="flex items-center justify-between gap-2 rounded-xl bg-surface p-2 text-xs">
              <span className="min-w-0 truncate font-mono">{description}</span>
              <button
                type="button"
                onClick={() => onDiscard(entry.path)}
                aria-label={`Discard ${description}`}
                className={SMALL_BUTTON}
              >
                Discard
              </button>
            </li>
          );
        })}
      </ul>
    )}
  </section>
);

export type ListingActions = {
  onRename: (path: string, newName: string) => void;
  onDelete: (path: string, directory: boolean) => void;
};

const RowActions: FC<{ name: string; path: string; directory: boolean; actions: ListingActions }> = ({
  name,
  path,
  directory,
  actions,
}) => {
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="mt-1 space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setRenaming(!renaming)} aria-label={`Rename ${name}`} className={SMALL_BUTTON}>
          Rename
        </button>
        <button
          type="button"
          onClick={() => actions.onDelete(path, directory)}
          aria-label={`Delete ${name}`}
          className={SMALL_BUTTON}
        >
          Delete
        </button>
      </div>
      {renaming ? (
        <NameForm
          label="New name"
          buttonLabel="Rename"
          initialValue={name}
          onSubmit={(newName) => {
            setRenaming(false);
            actions.onRename(path, newName);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
};

/** A directory listing; directories descend, files open the viewer, rows can carry a mark and actions. */
export const FilesListing: FC<{
  view: ListingView;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  marks?: Record<string, string>;
  actions?: ListingActions | null;
}> = ({ view, onOpenDirectory, onOpenFile, marks = {}, actions = null }) => {
  if (view.empty) {
    return <p className="rounded-xl bg-surface p-4 text-xs opacity-70">This folder is empty</p>;
  }
  return (
    <div>
      <ul aria-label="Folder contents" className="grid gap-1.5">
        {view.rows.map((row) => {
          const mark = marks[row.path] ?? null;
          return (
            <li key={row.path}>
              <button
                type="button"
                onClick={() => (row.opensDirectory ? onOpenDirectory(row.path) : onOpenFile(row.path))}
                aria-label={`${row.kindLabel} ${row.name}${row.sizeLabel ? `, ${row.sizeLabel}` : ""}${row.linkTarget ? `, links to ${row.linkTarget}` : ""}${mark ? `, ${mark}` : ""}`}
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
                  {mark ? <span className="block text-[0.65rem] font-bold">{mark}</span> : null}
                </span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[0.65rem] opacity-70">
                  {row.sizeLabel ? <span>{row.sizeLabel}</span> : null}
                  <span className="uppercase">{row.kindLabel}</span>
                </span>
              </button>
              {actions ? (
                <RowActions name={row.name} path={row.path} directory={row.opensDirectory} actions={actions} />
              ) : null}
            </li>
          );
        })}
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

/** The viewer for one file: text as escaped monospace, images from a Blob URL, else a plain note. */
export const FileViewer: FC<{
  name: string;
  body: ViewerBody;
  size: number;
  sha256: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadedBytes: number;
  copied: boolean;
  onLoadMore: () => void;
  onCopy: () => void;
  mark?: string | null;
  revealed?: boolean;
  canEdit?: boolean;
  tooLargeToEdit?: boolean;
  onEdit?: () => void;
  onReveal?: () => void;
  onHide?: () => void;
}> = ({
  name,
  body,
  size,
  sha256,
  hasMore,
  loadingMore,
  loadedBytes,
  copied,
  onLoadMore,
  onCopy,
  mark = null,
  revealed = false,
  canEdit = false,
  tooLargeToEdit = false,
  onEdit,
  onReveal,
  onHide,
}) => (
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
    {mark ? <p className="mt-1 text-xs font-bold">{mark}</p> : null}
    <div className="mt-2">
      {body.kind === "masked" ? (
        <div className="space-y-2">
          <p role="status" className="rounded-xl bg-surface-raised p-3 text-xs">{MASKED_FILE_MESSAGE}</p>
          {onReveal ? (
            <button type="button" onClick={onReveal} className={SMALL_BUTTON}>
              Reveal
            </button>
          ) : null}
        </div>
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
            {canEdit && onEdit ? (
              <button type="button" onClick={onEdit} aria-label={`Edit ${name}`} className={SMALL_BUTTON}>
                Edit
              </button>
            ) : null}
            {revealed && onHide ? (
              <button type="button" onClick={onHide} className={SMALL_BUTTON}>
                Hide
              </button>
            ) : null}
            <span role="status" aria-live="polite" className="text-xs opacity-70">
              {copied ? "Copied" : ""}
            </span>
          </div>
          {tooLargeToEdit ? <p className="mt-2 text-xs opacity-70">{TOO_LARGE_TO_EDIT_MESSAGE}</p> : null}
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

/** The text area for one edit, its notices and Save. A failed save keeps the draft and says why. */
export const FileEditor: FC<{
  name: string;
  session: EditSession;
  blockedReason: string | null;
  onChange: (text: string) => void;
  onSave: () => void;
  onRetry: () => void;
  onReload: () => void;
  onShowTheirs: () => void;
}> = ({ name, session, blockedReason, onChange, onSave, onRetry, onReload, onShowTheirs }) => {
  const notice = session.notice;
  const saving = session.phase === "saving";
  return (
    <section aria-label={`Editing ${name}`} className="space-y-2 rounded-2xl bg-surface p-3">
      {session.piChanged ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber/15 p-3 text-xs">
          <p className="font-semibold">Pi changed this a moment ago</p>
          <button type="button" onClick={onShowTheirs} className={SMALL_BUTTON}>
            Show their version
          </button>
        </div>
      ) : null}
      <label className="block text-xs font-bold" htmlFor="computer-file-editor">
        Editing {name}
      </label>
      <textarea
        id="computer-file-editor"
        value={session.draft}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        rows={12}
        className={`min-h-48 w-full resize-y rounded-xl bg-surface-raised px-3 py-2 font-mono text-xs leading-5 ${FOCUS}`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={blockedReason !== null}
          data-testid="save-button"
          className={`${SMALL_BUTTON} disabled:opacity-50`}
        >
          Save
        </button>
        <p role="status" aria-live="polite" className="text-xs">
          {saving ? "Saving" : blockedReason}
        </p>
      </div>
      {notice && notice.kind === "error" ? (
        <div role={notice.view.tone === "error" ? "alert" : "status"} className="rounded-xl bg-clay/15 p-3 text-xs">
          <p className="font-semibold">{notice.view.title}</p>
          {notice.view.reloadInstead ? (
            <button type="button" onClick={onReload} className={`mt-2 ${SMALL_BUTTON}`}>
              Reload
            </button>
          ) : notice.view.retryable ? (
            <button type="button" onClick={onRetry} className={`mt-2 ${SMALL_BUTTON}`}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

/** Two read-only versions of a file side by side on a wide screen, stacked on a phone. */
export const ConflictBanner: FC<{
  conflict: ConflictView;
  busy: boolean;
  onOverwrite: () => void;
  onUseTheirs: () => void;
  onCopyMine: () => void;
}> = ({ conflict, busy, onOverwrite, onUseTheirs, onCopyMine }) => (
  <section role="alert" aria-label="Conflict" className="space-y-2 rounded-2xl bg-clay/15 p-3" data-testid="conflict-banner">
    <p className="text-xs font-extrabold">
      {conflict.origin === "overlay"
        ? "Your edit conflicts with a newer version of this file"
        : "This file changed on the computer while you were editing."}
    </p>
    <div className="grid gap-2 md:grid-cols-2">
      <div>
        <p className="text-[0.65rem] font-bold uppercase tracking-wide">The saved version</p>
        <pre
          tabIndex={0}
          aria-label="Their version"
          className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2 font-mono text-xs leading-5 ${FOCUS}`}
        >
          {conflict.theirsText === "" ? "(empty file)" : conflict.theirsText}
        </pre>
      </div>
      <div>
        <p className="text-[0.65rem] font-bold uppercase tracking-wide">Your text</p>
        <pre
          tabIndex={0}
          aria-label="Your version"
          className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2 font-mono text-xs leading-5 ${FOCUS}`}
        >
          {conflict.mineText === "" ? "(empty file)" : conflict.mineText}
        </pre>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={onOverwrite} disabled={busy} className={`${SMALL_BUTTON} disabled:opacity-50`}>
        Overwrite with mine
      </button>
      <button type="button" onClick={onUseTheirs} className={SMALL_BUTTON}>
        Use theirs
      </button>
      <button type="button" onClick={onCopyMine} className={SMALL_BUTTON}>
        Copy mine
      </button>
    </div>
  </section>
);
