"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { listComputerFiles, readComputerFileRange } from "@/lib/computer-files-api";
import {
  CONTENT_RANGE_BYTES,
  WORKSPACE_ROOT,
  advanceRangeState,
  asOfLabel,
  base64ToBytes,
  buildListingView,
  classifyFirstRange,
  describeFilesError,
  normalizeWorkspacePath,
  parentDirectory,
  rangeChangedUnderneath,
  sniffImageType,
  startRangeState,
  type FileContentRange,
  type FileListing,
  type FilesErrorView,
  type RangeState,
} from "@/lib/computer-files";
import type { ActiveOrg } from "@/lib/membership-state";
import type { TouchedFile } from "@/lib/touched-files";
import {
  FileViewer,
  FilesBreadcrumb,
  FilesListing,
  FilesLoading,
  FilesNotice,
  SavedCopyNote,
  TouchedFilesList,
  type FileViewerBody,
} from "./ComputerFilesView";

type ListingState =
  | { status: "loading" }
  | { status: "error"; view: FilesErrorView }
  | { status: "ready"; listing: FileListing };

type ViewerState =
  | { status: "loading"; path: string }
  | { status: "error"; path: string; view: FilesErrorView }
  | {
      status: "ready";
      path: string;
      body: FileViewerBody;
      range: RangeState;
      asOf: string | null;
    };

type Props = {
  org: ActiveOrg;
  touched: readonly TouchedFile[];
};

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/**
 * Read-only browser for the last saved copy of the organization's computer.
 * Nothing is polled: the listing loads on open, on navigation and on refresh.
 */
export function ComputerFilesPanel({ org, touched }: Props) {
  const [directory, setDirectory] = useState(WORKSPACE_ROOT);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [listingState, setListingState] = useState<ListingState>({ status: "loading" });
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const listingRequest = useRef(0);
  const viewerRequest = useRef(0);
  const textRef = useRef("");
  const blobUrlRef = useRef<string | null>(null);

  const releaseBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  useEffect(() => releaseBlobUrl, [releaseBlobUrl]);

  useEffect(() => {
    const request = ++listingRequest.current;
    setListingState({ status: "loading" });
    listComputerFiles(org, directory)
      .then((listing) => {
        if (request !== listingRequest.current) return;
        setNow(Date.now());
        setListingState({ status: "ready", listing });
      })
      .catch((error: unknown) => {
        if (request !== listingRequest.current) return;
        setListingState({ status: "error", view: describeFilesError(error) });
      });
  }, [org, directory, refreshToken]);

  const loadFile = useCallback(
    async (path: string) => {
      const request = ++viewerRequest.current;
      releaseBlobUrl();
      textRef.current = "";
      setCopied(false);
      setViewer({ status: "loading", path });
      try {
        const first = await readComputerFileRange(org, path, 0, CONTENT_RANGE_BYTES);
        if (request !== viewerRequest.current) return;
        const preview = classifyFirstRange(first);
        if (preview.kind === "masked") {
          setViewer({ status: "ready", path, body: { kind: "masked" }, range: startRangeState(first), asOf: first.as_of });
          return;
        }
        if (preview.kind === "binary") {
          setViewer({ status: "ready", path, body: { kind: "binary", size: preview.size }, range: startRangeState(first), asOf: first.as_of });
          return;
        }
        if (preview.kind === "text") {
          textRef.current = first.content;
          setViewer({
            status: "ready",
            path,
            body: { kind: "text", text: first.content },
            range: startRangeState(first),
            asOf: first.as_of,
          });
          return;
        }
        const firstBytes = base64ToBytes(first.content);
        if (sniffImageType(firstBytes) === null) {
          setViewer({ status: "ready", path, body: { kind: "binary", size: first.size }, range: startRangeState(first), asOf: first.as_of });
          return;
        }
        const parts: Uint8Array[] = [firstBytes];
        let state = startRangeState(first);
        while (!state.done) {
          const next = await readComputerFileRange(org, path, state.nextOffset, CONTENT_RANGE_BYTES);
          if (request !== viewerRequest.current) return;
          if (rangeChangedUnderneath(state, next) || next.offset !== state.nextOffset) throw new Error("changed");
          parts.push(base64ToBytes(next.content));
          state = advanceRangeState(state, next);
        }
        const bytes = concatBytes(parts);
        const mime = sniffImageType(bytes);
        if (mime === null) {
          setViewer({ status: "ready", path, body: { kind: "binary", size: first.size }, range: state, asOf: first.as_of });
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        blobUrlRef.current = url;
        setViewer({ status: "ready", path, body: { kind: "image", url, mime }, range: state, asOf: first.as_of });
      } catch (error) {
        if (request !== viewerRequest.current) return;
        setViewer({ status: "error", path, view: describeFilesError(error) });
      }
    },
    [org, releaseBlobUrl],
  );

  const loadMore = useCallback(async () => {
    if (!viewer || viewer.status !== "ready" || viewer.body.kind !== "text" || viewer.range.done) return;
    const request = viewerRequest.current;
    const { path, range } = viewer;
    setLoadingMore(true);
    try {
      const next: FileContentRange = await readComputerFileRange(org, path, range.nextOffset, CONTENT_RANGE_BYTES);
      if (request !== viewerRequest.current) return;
      if (rangeChangedUnderneath(range, next)) {
        void loadFile(path);
        return;
      }
      textRef.current += next.content;
      setViewer({
        status: "ready",
        path,
        body: { kind: "text", text: textRef.current },
        range: advanceRangeState(range, next),
        asOf: next.as_of,
      });
    } catch (error) {
      if (request !== viewerRequest.current) return;
      setViewer({ status: "error", path, view: describeFilesError(error) });
    } finally {
      setLoadingMore(false);
    }
  }, [loadFile, org, viewer]);

  const openFilePath = useCallback(
    (path: string) => {
      const normalized = normalizeWorkspacePath(path);
      if (normalized === null) return;
      setDirectory(parentDirectory(normalized));
      setOpenFile(normalized);
      void loadFile(normalized);
    },
    [loadFile],
  );

  const navigateTo = useCallback((path: string) => {
    viewerRequest.current += 1;
    releaseBlobUrl();
    setOpenFile(null);
    setViewer(null);
    setDirectory(path);
  }, [releaseBlobUrl]);

  const copyText = useCallback(() => {
    void navigator.clipboard
      ?.writeText(textRef.current)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, []);

  const refresh = useCallback(() => {
    setRefreshToken((token) => token + 1);
    if (openFile) void loadFile(openFile);
  }, [loadFile, openFile]);

  const listing = listingState.status === "ready" ? listingState.listing : null;
  const asOf = viewer?.status === "ready" ? viewer.asOf : listing?.as_of ?? null;
  const shownPath = openFile ?? directory;

  return (
    <div className="space-y-3" data-testid="computer-files-panel">
      <TouchedFilesList files={touched} onOpen={openFilePath} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <FilesBreadcrumb path={shownPath} onNavigate={navigateTo} />
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh files"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>

      <SavedCopyNote asOfText={asOfLabel(asOf, now)} />

      {openFile ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => navigateTo(parentDirectory(openFile))}
            className="inline-flex min-h-11 items-center rounded-full bg-surface px-4 text-xs font-bold hover:bg-surface-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
          >
            Back to folder
          </button>
          {viewer?.status === "loading" ? <FilesLoading label="Loading file" /> : null}
          {viewer?.status === "error" ? (
            <FilesNotice view={viewer.view} onRetry={() => void loadFile(viewer.path)} />
          ) : null}
          {viewer?.status === "ready" ? (
            <FileViewer
              name={fileNameOf(viewer.path)}
              body={viewer.body}
              size={viewer.range.size}
              sha256={viewer.range.sha256}
              hasMore={viewer.body.kind === "text" && !viewer.range.done}
              loadingMore={loadingMore}
              loadedBytes={viewer.range.loadedBytes}
              copied={copied}
              onLoadMore={() => void loadMore()}
              onCopy={copyText}
            />
          ) : null}
        </div>
      ) : (
        <>
          {listingState.status === "loading" ? <FilesLoading label="Loading files" /> : null}
          {listingState.status === "error" ? (
            <FilesNotice view={listingState.view} onRetry={() => setRefreshToken((token) => token + 1)} />
          ) : null}
          {listing ? (
            <FilesListing
              view={buildListingView(listing)}
              onOpenDirectory={navigateTo}
              onOpenFile={openFilePath}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
