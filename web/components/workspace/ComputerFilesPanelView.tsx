import type { FC } from "react";
import { RefreshCw } from "lucide-react";

import { buildListingView } from "@/lib/computer-files";
import type { PanelSnapshot } from "@/lib/computer-files-controller";
import { offerEditor, saveBlockedReason } from "@/lib/computer-files-edit";
import type { TouchedFile } from "@/lib/touched-files";
import {
  ConfirmBar,
  ConflictBanner,
  FileEditor,
  FileViewer,
  FilesBreadcrumb,
  FilesListing,
  FilesLoading,
  FilesNotice,
  FilesToolbar,
  PendingChangesList,
  SourceLineView,
  StatusLineView,
  TouchedFilesList,
} from "./ComputerFilesView";

/** What a click on the panel does; the controller supplies these. */
export type PanelHandlers = {
  onRefresh: () => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onBack: () => void;
  onLoadMore: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDraft: (text: string) => void;
  onSave: () => void;
  onRetrySave: () => void;
  onReloadUnknown: () => void;
  onShowTheirs: () => void;
  onOverwrite: () => void;
  onUseTheirs: () => void;
  onCopyMine: () => void;
  onRequestReveal: () => void;
  onHide: () => void;
  onAnswer: (confirmed: boolean) => void;
  onNewFile: (name: string) => void;
  onNewFolder: (name: string) => void;
  onRename: (path: string, newName: string) => void;
  onDelete: (path: string, directory: boolean) => void;
  onOpenPending: () => void;
  onClosePending: () => void;
  onDiscardPending: (path: string) => void;
};

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/**
 * The whole Files panel as a function of a snapshot: the same markup in the
 * browser and in the behavior scenarios, which read this render to see what
 * a member would see.
 */
export const ComputerFilesPanelView: FC<{
  snapshot: PanelSnapshot;
  touched: readonly TouchedFile[];
  copied: boolean;
  handlers: PanelHandlers;
}> = ({ snapshot, touched, copied, handlers }) => {
  const { listing, viewer, edit, conflict, openFile } = snapshot;
  const shownPath = openFile ?? snapshot.directory;
  const readyListing = listing.status === "ready" ? listing.listing : null;
  const ready = viewer && viewer.status === "ready" ? viewer : null;
  const offer = ready ? offerEditor(ready.first) : null;
  const canEditHere = offer?.offered === true && snapshot.changesOffered && edit === null;
  const tooLarge = ready?.body.kind === "text" && offer !== null && !offer.offered && offer.reason === "too-large";
  const mark = openFile ? snapshot.marks[openFile] ?? null : null;
  return (
    <div className="space-y-3" data-testid="computer-files-panel">
      <TouchedFilesList files={touched} onOpen={handlers.onOpenFile} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <FilesBreadcrumb path={shownPath} onNavigate={handlers.onOpenDirectory} />
        </div>
        <button
          type="button"
          onClick={handlers.onRefresh}
          aria-label="Refresh files"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>

      <SourceLineView line={snapshot.source} onRetry={handlers.onRefresh} />
      <StatusLineView status={snapshot.status} onReload={handlers.onReloadUnknown} onRetry={handlers.onRefresh} />
      <ConfirmBar confirm={snapshot.confirm} onAnswer={handlers.onAnswer} />

      {snapshot.pending.open ? (
        <PendingChangesList
          entries={snapshot.pending.entries}
          onDiscard={handlers.onDiscardPending}
          onClose={handlers.onClosePending}
        />
      ) : null}

      {openFile ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={handlers.onBack}
            className="inline-flex min-h-11 items-center rounded-full bg-surface px-4 text-xs font-bold hover:bg-surface-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
          >
            Back to folder
          </button>
          {viewer?.status === "loading" ? <FilesLoading label="Loading file" /> : null}
          {viewer?.status === "error" ? <FilesNotice view={viewer.view} onRetry={handlers.onRefresh} /> : null}
          {conflict ? (
            <ConflictBanner
              conflict={conflict}
              busy={snapshot.busy}
              onOverwrite={handlers.onOverwrite}
              onUseTheirs={handlers.onUseTheirs}
              onCopyMine={handlers.onCopyMine}
            />
          ) : null}
          {edit ? (
            <FileEditor
              name={fileNameOf(edit.path)}
              session={edit}
              blockedReason={saveBlockedReason(edit)}
              onChange={handlers.onDraft}
              onSave={handlers.onSave}
              onRetry={handlers.onRetrySave}
              onReload={handlers.onReloadUnknown}
              onShowTheirs={handlers.onShowTheirs}
            />
          ) : null}
          {ready && edit === null ? (
            <FileViewer
              name={fileNameOf(ready.path)}
              body={ready.body}
              size={ready.range.size}
              sha256={ready.range.sha256}
              hasMore={ready.body.kind === "text" && !ready.range.done}
              loadingMore={false}
              loadedBytes={ready.range.loadedBytes}
              copied={copied}
              mark={mark}
              revealed={ready.revealed}
              canEdit={canEditHere}
              tooLargeToEdit={tooLarge}
              onLoadMore={handlers.onLoadMore}
              onCopy={handlers.onCopy}
              onEdit={handlers.onEdit}
              onReveal={handlers.onRequestReveal}
              onHide={handlers.onHide}
            />
          ) : null}
        </div>
      ) : (
        <>
          {listing.status === "loading" ? <FilesLoading label="Loading files" /> : null}
          {listing.status === "error" ? <FilesNotice view={listing.view} onRetry={handlers.onRefresh} /> : null}
          {readyListing ? (
            <>
              <FilesToolbar
                canChange={snapshot.changesOffered}
                pendingCount={snapshot.pending.entries.length}
                onNewFile={handlers.onNewFile}
                onNewFolder={handlers.onNewFolder}
                onOpenPending={handlers.onOpenPending}
              />
              <FilesListing
                view={buildListingView(readyListing)}
                marks={snapshot.marks}
                actions={
                  snapshot.changesOffered ? { onRename: handlers.onRename, onDelete: handlers.onDelete } : null
                }
                onOpenDirectory={handlers.onOpenDirectory}
                onOpenFile={handlers.onOpenFile}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
