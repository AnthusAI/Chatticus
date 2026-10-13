/**
 * The behavior of the Files panel, with no React and no DOM: what is listed
 * and open, where the answer came from, the editor and its conflict banner,
 * the pings and probes on timers, delete, rename and new folders, and the
 * changes waiting for the computer. The React panel renders a snapshot and
 * forwards clicks; the behavior scenarios drive the same object with a fake
 * clock. Every route goes through the injected api.
 */

import type { ComputerFilesApi } from "./computer-files-api";
import {
  CONTENT_RANGE_BYTES,
  FALLBACK_RETRY_LIMIT,
  FilesApiError,
  WORKSPACE_ROOT,
  advanceRangeState,
  answerWantsRetry,
  base64ToBytes,
  childPath,
  classifyFirstRange,
  describeFilesError,
  describeSourceLine,
  entryNameProblem,
  fallbackRetryDelayMs,
  normalizeWorkspacePath,
  parentDirectory,
  rangeChangedUnderneath,
  sniffImageType,
  startRangeState,
  type FileContentRange,
  type FileListing,
  type FileProvenance,
  type FileWatchState,
  type FilesErrorView,
  type RangeState,
  type SourceLine,
} from "./computer-files";
import {
  EDIT_MAX_BYTES,
  beginSave,
  changeDraft,
  changedSinceLoad,
  describeSaveSuccess,
  draftIsChanged,
  failSave,
  saveBlockedReason,
  startEditSession,
  startNewFileSession,
  type EditSession,
  type SaveMessage,
} from "./computer-files-edit";
import {
  describePendingChange,
  markForListingRow,
  overlayEntriesByPath,
  sortPendingChanges,
  type OverlayEntry,
} from "./computer-files-overlay";
import type { TouchedFile } from "./touched-files";

export const LIVE_WATCH_INTERVAL_MS = 15000;
export const EDIT_PROBE_INTERVAL_MS = 5000;
export const WATCH_RATE_PAUSE_MS = 60000;
export const DESCENDANT_WALK_LIMIT = 5000;

export type Scheduler = {
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
};

/** The browser's timers and clock. */
export const browserScheduler: Scheduler = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type ViewerBody =
  | { kind: "masked" }
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; mime: string }
  | { kind: "binary"; size: number };

export type ListingPhase =
  | { status: "loading" }
  | { status: "error"; view: FilesErrorView }
  | { status: "ready"; listing: FileListing };

export type ViewerPhase =
  | { status: "loading"; path: string }
  | { status: "error"; path: string; view: FilesErrorView }
  | { status: "ready"; path: string; body: ViewerBody; range: RangeState; first: FileContentRange; revealed: boolean };

export type ConflictView = {
  origin: "edit" | "overlay";
  path: string;
  theirsText: string;
  theirsSha256: string;
  mineText: string;
};

export type PanelConfirm = {
  id: "discard-draft" | "reveal" | "delete" | "delete-blocked" | "discard-pending" | "use-theirs";
  text: string;
  confirmLabel: string | null;
  cancelLabel: string;
};

export type StatusMessage = {
  tone: "ok" | "error" | "notice";
  text: string;
  detail: string | null;
  reloadInstead?: boolean;
  retryable?: boolean;
};

export type PendingPanel = {
  open: boolean;
  entries: OverlayEntry[];
  loaded: boolean;
};

export type PanelSnapshot = {
  active: boolean;
  role: "owner" | "member";
  directory: string;
  openFile: string | null;
  provenance: FileProvenance | null;
  watchState: FileWatchState["state"] | null;
  source: SourceLine;
  changesOffered: boolean;
  listing: ListingPhase;
  marks: Record<string, string>;
  viewer: ViewerPhase | null;
  edit: EditSession | null;
  conflict: ConflictView | null;
  status: StatusMessage | null;
  confirm: PanelConfirm | null;
  pending: PendingPanel;
  busy: boolean;
  fallbackRetriesLeft: number;
};

export type ControllerOptions = {
  api: ComputerFilesApi;
  scheduler?: Scheduler;
  role: "owner" | "member";
};

export type NavigationTarget = { kind: "directory"; path: string } | { kind: "file"; path: string } | { kind: "none" };

type TimerName = "watch" | "probe" | "fallback" | "saveRetry" | "watchPause";

/** The Files panel's state machine. */
export class ComputerFilesController {
  private readonly api: ComputerFilesApi;
  private readonly scheduler: Scheduler;
  private snapshot: PanelSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<TimerName, unknown>();
  private listingRequest = 0;
  private viewerRequest = 0;
  private fallbackAttempts = 0;
  private confirmAction: (() => Promise<void>) | null = null;
  private ranges: RangeState | null = null;
  private loadedText = "";
  private blobUrl: string | null = null;
  private seenWriteSignatures = new Map<string, string>();
  private touchedBaselined = false;
  private started = false;
  private everActive = false;
  private disposed = false;
  private overlayEntries: OverlayEntry[] = [];

  constructor(options: ControllerOptions) {
    this.api = options.api;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.snapshot = {
      active: false,
      role: options.role,
      directory: WORKSPACE_ROOT,
      openFile: null,
      provenance: null,
      watchState: null,
      source: describeSourceLine(null, null, this.scheduler.now()),
      changesOffered: false,
      listing: { status: "loading" },
      marks: {},
      viewer: null,
      edit: null,
      conflict: null,
      status: null,
      confirm: null,
      pending: { open: false, entries: [], loaded: false },
      busy: false,
      fallbackRetriesLeft: FALLBACK_RETRY_LIMIT,
    };
  }

  getSnapshot = (): PanelSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<PanelSnapshot>): void {
    const merged = { ...this.snapshot, ...patch };
    merged.source = describeSourceLine(merged.provenance, merged.watchState, this.scheduler.now());
    merged.changesOffered = this.changesAreOffered(merged.provenance);
    this.snapshot = merged;
    for (const listener of [...this.listeners]) listener();
  }

  private changesAreOffered(provenance: FileProvenance | null): boolean {
    if (provenance === null) return false;
    return !provenance.stale && provenance.fallback_reason === null;
  }

  private startTimer(name: TimerName, delayMs: number, callback: () => void): void {
    this.stopTimer(name);
    this.timers.set(
      name,
      this.scheduler.setTimer(() => {
        this.timers.delete(name);
        if (!this.disposed) callback();
      }, delayMs),
    );
  }

  private stopTimer(name: TimerName): void {
    const handle = this.timers.get(name);
    if (handle !== undefined) {
      this.scheduler.clearTimer(handle);
      this.timers.delete(name);
    }
  }

  /** Loads the first listing. Call once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loadListing(this.snapshot.directory);
  }

  /** Stops every timer and drops anything held only in memory. */
  dispose(): void {
    this.disposed = true;
    for (const name of [...this.timers.keys()]) this.stopTimer(name);
    this.releaseBlobUrl();
    this.loadedText = "";
    this.listeners.clear();
  }

  private releaseBlobUrl(): void {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }

  /**
   * Whether the Files tab is the visible tab of a visible page. Becoming
   * active pings the control plane every 15 seconds; leaving posts one close
   * ping, stops the timers and forgets a revealed secret.
   */
  setActive(active: boolean): void {
    if (this.snapshot.active === active) return;
    this.set({ active });
    if (active) {
      const returning = this.everActive;
      this.everActive = true;
      void this.pingWatch();
      this.scheduleProbe();
      if (returning && this.started && !this.snapshot.edit) this.refresh();
    } else {
      this.stopTimer("watch");
      this.stopTimer("probe");
      this.stopTimer("watchPause");
      void this.api.watch(false, true).catch(() => undefined);
      this.clearReveal();
    }
  }

  private async pingWatch(): Promise<void> {
    if (!this.snapshot.active || this.disposed) return;
    this.stopTimer("watch");
    try {
      const answer = await this.api.watch(true);
      if (!this.snapshot.active) return;
      this.set({ watchState: answer.state });
      this.startTimer("watch", LIVE_WATCH_INTERVAL_MS, () => void this.pingWatch());
    } catch (error) {
      if (!this.snapshot.active) return;
      if (error instanceof FilesApiError && error.status === 429) {
        this.startTimer("watchPause", WATCH_RATE_PAUSE_MS, () => void this.pingWatch());
        return;
      }
      this.startTimer("watch", LIVE_WATCH_INTERVAL_MS, () => void this.pingWatch());
    }
  }

  private async loadListing(directory: string): Promise<void> {
    const request = ++this.listingRequest;
    if (this.snapshot.listing.status !== "ready" || this.snapshot.directory !== directory) {
      this.set({ listing: { status: "loading" } });
    }
    try {
      const listing = await this.api.list(directory);
      if (request !== this.listingRequest) return;
      let entries = this.overlayEntries;
      const wantsPending = listing.source === "snapshot" || listing.entries.some((entry) => entry.overlay !== "none");
      if (wantsPending) {
        entries = await this.api.pending().catch(() => []);
        if (request !== this.listingRequest) return;
        this.overlayEntries = entries;
      } else {
        this.overlayEntries = [];
        entries = [];
      }
      const byPath = overlayEntriesByPath(entries);
      const marks: Record<string, string> = {};
      for (const entry of listing.entries) {
        const mark = markForListingRow(entry.overlay ?? "none", byPath.get(entry.path));
        if (mark !== null) marks[entry.path] = mark;
      }
      this.set({
        listing: { status: "ready", listing },
        marks,
        provenance: this.snapshot.openFile ? this.snapshot.provenance : listing,
        pending: { ...this.snapshot.pending, entries: sortPendingChanges(entries), loaded: wantsPending },
      });
      if (!this.snapshot.openFile) this.afterAnswer(listing);
    } catch (error) {
      if (request !== this.listingRequest) return;
      this.set({ listing: { status: "error", view: describeFilesError(error) } });
    }
  }

  private afterAnswer(provenance: FileProvenance): void {
    if (answerWantsRetry(provenance)) {
      if (this.fallbackAttempts < FALLBACK_RETRY_LIMIT) {
        this.fallbackAttempts += 1;
        this.set({ fallbackRetriesLeft: FALLBACK_RETRY_LIMIT - this.fallbackAttempts });
        this.startTimer("fallback", fallbackRetryDelayMs(provenance), () => this.refresh({ automatic: true }));
      } else {
        this.set({ fallbackRetriesLeft: 0 });
      }
    } else {
      this.stopTimer("fallback");
      this.fallbackAttempts = 0;
      this.set({ fallbackRetriesLeft: FALLBACK_RETRY_LIMIT });
    }
  }

  /** Reads the listing and the open file again; a click resets the automatic retries. */
  refresh(options: { automatic?: boolean } = {}): void {
    if (!options.automatic) {
      this.fallbackAttempts = 0;
      this.stopTimer("fallback");
    }
    void this.loadListing(this.snapshot.directory);
    const open = this.snapshot.openFile;
    if (open && !this.snapshot.edit) void this.loadFile(open);
  }

  private async loadFile(path: string, options: { keepStatus?: boolean } = {}): Promise<void> {
    const request = ++this.viewerRequest;
    this.releaseBlobUrl();
    this.loadedText = "";
    this.ranges = null;
    this.set({
      viewer: { status: "loading", path },
      conflict: null,
      status: options.keepStatus ? this.snapshot.status : null,
    });
    try {
      const first = await this.api.read(path, 0, CONTENT_RANGE_BYTES);
      if (request !== this.viewerRequest) return;
      const state = startRangeState(first);
      this.ranges = state;
      const preview = classifyFirstRange(first);
      if (preview.kind === "masked") {
        this.setViewer(path, { kind: "masked" }, state, first, false);
        return;
      }
      if (preview.kind === "binary") {
        this.setViewer(path, { kind: "binary", size: preview.size }, state, first, false);
        return;
      }
      if (preview.kind === "text") {
        this.loadedText = first.content;
        this.setViewer(path, { kind: "text", text: first.content }, state, first, false);
        if (first.overlay === "conflict") await this.loadOverlayConflict(path, first, request);
        return;
      }
      const firstBytes = base64ToBytes(first.content);
      if (sniffImageType(firstBytes) === null) {
        this.setViewer(path, { kind: "binary", size: first.size }, state, first, false);
        return;
      }
      const parts: Uint8Array[] = [firstBytes];
      let running = state;
      while (!running.done) {
        const next = await this.api.read(path, running.nextOffset, CONTENT_RANGE_BYTES);
        if (request !== this.viewerRequest) return;
        if (rangeChangedUnderneath(running, next) || next.offset !== running.nextOffset) throw new Error("changed");
        parts.push(base64ToBytes(next.content));
        running = advanceRangeState(running, next);
      }
      const bytes = joinBytes(parts);
      const mime = sniffImageType(bytes);
      if (mime === null) {
        this.setViewer(path, { kind: "binary", size: first.size }, running, first, false);
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      this.blobUrl = url;
      this.setViewer(path, { kind: "image", url, mime }, running, first, false);
    } catch (error) {
      if (request !== this.viewerRequest) return;
      this.set({ viewer: { status: "error", path, view: describeFilesError(error) } });
    }
  }

  private setViewer(path: string, body: ViewerBody, range: RangeState, first: FileContentRange, revealed: boolean): void {
    this.set({
      viewer: { status: "ready", path, body, range, first, revealed },
      provenance: first,
    });
    this.afterAnswer(first);
  }

  private async loadOverlayConflict(path: string, theirs: FileContentRange, request: number): Promise<void> {
    try {
      const [mine, entries] = await Promise.all([
        this.api.read(path, 0, CONTENT_RANGE_BYTES, "mine"),
        this.api.pending().catch(() => [] as OverlayEntry[]),
      ]);
      if (request !== this.viewerRequest) return;
      this.overlayEntries = entries;
      this.set({
        conflict: { origin: "overlay", path, theirsText: theirs.content, theirsSha256: theirs.sha256, mineText: mine.content },
        pending: { ...this.snapshot.pending, entries: sortPendingChanges(entries), loaded: true },
      });
    } catch (error) {
      if (request !== this.viewerRequest) return;
      this.set({ status: statusFromError(error) });
    }
  }

  /** Loads more of a long text file. */
  async loadMore(): Promise<void> {
    const viewer = this.snapshot.viewer;
    if (!viewer || viewer.status !== "ready" || viewer.body.kind !== "text" || viewer.range.done) return;
    const request = this.viewerRequest;
    try {
      const next = await this.api.read(viewer.path, viewer.range.nextOffset, CONTENT_RANGE_BYTES);
      if (request !== this.viewerRequest) return;
      if (rangeChangedUnderneath(viewer.range, next)) {
        void this.loadFile(viewer.path);
        return;
      }
      this.loadedText += next.content;
      this.set({
        viewer: { ...viewer, body: { kind: "text", text: this.loadedText }, range: advanceRangeState(viewer.range, next) },
      });
    } catch (error) {
      if (request !== this.viewerRequest) return;
      this.set({ viewer: { status: "error", path: viewer.path, view: describeFilesError(error) } });
    }
  }

  /** The loaded text of the open file, for Copy. */
  currentText(): string {
    return this.loadedText;
  }

  /** The text Copy mine puts on the clipboard. */
  mineText(): string | null {
    const conflict = this.snapshot.conflict;
    if (!conflict) return null;
    return conflict.origin === "edit" ? this.snapshot.edit?.draft ?? "" : conflict.mineText;
  }

  private isDirty(): boolean {
    const edit = this.snapshot.edit;
    return edit !== null && draftIsChanged(edit);
  }

  /** Goes to a folder or file now, or asks first when a changed draft would be lost. */
  navigate(target: NavigationTarget): void {
    if (this.isDirty()) {
      this.askConfirm(
        { id: "discard-draft", text: "Discard your changes?", confirmLabel: "Discard", cancelLabel: "Keep editing" },
        async () => this.performNavigation(target),
      );
      return;
    }
    this.performNavigation(target);
  }

  private performNavigation(target: NavigationTarget): void {
    this.stopTimer("probe");
    this.stopTimer("saveRetry");
    this.viewerRequest += 1;
    this.releaseBlobUrl();
    this.loadedText = "";
    if (target.kind === "file") {
      const normalized = normalizeWorkspacePath(target.path);
      if (normalized === null) return;
      const directory = parentDirectory(normalized);
      const directoryChanged = directory !== this.snapshot.directory || this.snapshot.listing.status !== "ready";
      this.set({ edit: null, conflict: null, status: null, openFile: normalized, directory });
      void this.loadFile(normalized);
      if (directoryChanged) void this.loadListing(directory);
      return;
    }
    const directory = target.kind === "directory" ? target.path : this.snapshot.directory;
    this.set({ edit: null, conflict: null, status: null, openFile: null, viewer: null, directory });
    void this.loadListing(directory);
  }

  /** Back to the folder of the open file. */
  backToFolder(): void {
    const open = this.snapshot.openFile;
    this.navigate({ kind: "directory", path: open ? parentDirectory(open) : this.snapshot.directory });
  }

  /** Opens a file from the listing or the touched list. */
  openFile(path: string): void {
    this.navigate({ kind: "file", path });
  }

  /** Opens a folder. */
  openDirectory(path: string): void {
    this.navigate({ kind: "directory", path });
  }

  private askConfirm(confirm: PanelConfirm, action: () => Promise<void> | void): void {
    this.confirmAction = async () => {
      await action();
    };
    this.set({ confirm });
  }

  /** Answers the open question. `true` is the confirming button. */
  async answerConfirm(confirmed: boolean): Promise<void> {
    const action = this.confirmAction;
    this.confirmAction = null;
    this.set({ confirm: null });
    if (confirmed && action) await action();
  }

  private clearReveal(): void {
    const viewer = this.snapshot.viewer;
    if (viewer && viewer.status === "ready" && viewer.revealed) {
      this.loadedText = "";
      const edit = this.snapshot.edit;
      this.set({
        viewer: { ...viewer, body: { kind: "masked" }, revealed: false },
        edit: edit !== null && edit.path === viewer.path ? null : edit,
      });
    }
  }

  /** Asks to show a masked file, naming what is recorded. */
  requestReveal(): void {
    this.askConfirm(
      {
        id: "reveal",
        text: "Showing this file is recorded in the audit log, with your name and the time.",
        confirmLabel: "Reveal",
        cancelLabel: "Cancel",
      },
      async () => {
        const viewer = this.snapshot.viewer;
        if (!viewer || viewer.status !== "ready") return;
        try {
          const revealed = await this.api.reveal(viewer.path);
          if (this.snapshot.viewer !== viewer) return;
          this.loadedText = revealed.content;
          this.set({
            viewer: {
              status: "ready",
              path: viewer.path,
              body: { kind: "text", text: revealed.content },
              range: startRangeState(revealed),
              first: revealed,
              revealed: true,
            },
            provenance: revealed,
          });
        } catch (error) {
          this.set({ status: statusFromError(error) });
        }
      },
    );
  }

  /** Hides a revealed file again. */
  hide(): void {
    this.clearReveal();
  }

  /** Starts editing the open text file. */
  beginEdit(): void {
    const viewer = this.snapshot.viewer;
    if (!viewer || viewer.status !== "ready" || viewer.body.kind !== "text" || this.snapshot.edit) return;
    if (!this.snapshot.changesOffered) return;
    const first = viewer.first;
    if (!first.editable || viewer.range.size > EDIT_MAX_BYTES || !viewer.range.done) return;
    this.set({
      edit: startEditSession({
        path: viewer.path,
        sha256: viewer.range.sha256,
        content: this.loadedText,
        size: viewer.range.size,
        modified_at: first.modified_at,
        source: first.source,
      }),
      status: null,
    });
    this.scheduleProbe();
  }

  /** Replaces the text of the draft. */
  setDraft(text: string): void {
    const edit = this.snapshot.edit;
    if (!edit) return;
    this.set({ edit: changeDraft(edit, text) });
  }

  /** Sends the draft with the hash it was loaded at. */
  async save(): Promise<void> {
    const edit = this.snapshot.edit;
    if (!edit || saveBlockedReason(edit) !== null) return;
    this.stopTimer("saveRetry");
    this.set({ edit: beginSave(edit), status: null });
    try {
      const precondition =
        edit.loadedSha256 === null
          ? ({ type: "if_none_match" } as const)
          : ({ type: "if_match", sha256: edit.loadedSha256 } as const);
      const result = await this.api.write(edit.path, edit.draft, precondition);
      await this.finishSave(edit.path, describeSaveSuccess(result));
    } catch (error) {
      const failure = failSave(this.snapshot.edit ?? edit, error);
      if (failure.kind === "conflict") {
        this.set({ edit: failure.session });
        await this.showTheirVersion(failure.currentSha256);
        return;
      }
      this.set({ edit: failure.session });
      if (failure.retryInMs !== null) this.startTimer("saveRetry", failure.retryInMs, () => void this.save());
    }
  }

  /** The Retry button after an automatic retry ran out: counts from zero again. */
  async retrySave(): Promise<void> {
    const edit = this.snapshot.edit;
    if (!edit) return;
    this.set({ edit: { ...edit, autoRetries: 0 } });
    await this.save();
  }

  private async finishSave(path: string, message: SaveMessage): Promise<void> {
    this.stopTimer("probe");
    this.set({
      edit: null,
      conflict: null,
      status: {
        tone: "ok",
        text: message.headline,
        detail: [message.detail, message.keptAsNotice].filter((part): part is string => part !== null).join(". ") || null,
      },
    });
    await this.loadFile(path, { keepStatus: true });
    void this.loadListing(this.snapshot.directory);
  }

  /** Reads the file as it is now and shows it beside the draft. */
  async showTheirVersion(knownSha256: string | null = null): Promise<void> {
    const edit = this.snapshot.edit;
    if (!edit) return;
    try {
      const current = await this.api.read(edit.path, 0, CONTENT_RANGE_BYTES);
      const theirsSha256 = knownSha256 ?? current.sha256;
      this.set({
        conflict: { origin: "edit", path: edit.path, theirsText: current.content, theirsSha256, mineText: edit.draft },
        edit: { ...(this.snapshot.edit ?? edit), piChanged: false },
      });
    } catch (error) {
      this.set({ status: statusFromError(error) });
    }
  }

  /** After "not sure the save happened": reads the file and compares it with the draft. */
  async reloadAfterUnknown(): Promise<void> {
    const edit = this.snapshot.edit;
    if (!edit) return;
    try {
      const current = await this.api.read(edit.path, 0, CONTENT_RANGE_BYTES);
      if (current.content === edit.draft) {
        await this.finishSave(edit.path, { headline: "Saved", detail: null, keptAsNotice: null });
        return;
      }
      this.set({
        edit: { ...edit, notice: null },
        conflict: { origin: "edit", path: edit.path, theirsText: current.content, theirsSha256: current.sha256, mineText: edit.draft },
      });
    } catch (error) {
      this.set({ status: statusFromError(error) });
    }
  }

  /** The conflict banner's Overwrite with mine: an ordinary write against the other version's hash. */
  async overwriteWithMine(): Promise<void> {
    const conflict = this.snapshot.conflict;
    if (!conflict) return;
    const text = this.mineText() ?? "";
    this.set({ busy: true });
    try {
      const result = await this.api.write(conflict.path, text, { type: "if_match", sha256: conflict.theirsSha256 });
      this.set({ busy: false });
      await this.finishSave(conflict.path, describeSaveSuccess(result));
    } catch (error) {
      if (error instanceof FilesApiError && error.code === "precondition_failed") {
        this.set({ busy: false });
        const edit = this.snapshot.edit;
        if (edit) await this.showTheirVersion(error.currentSha256);
        else this.set({ status: statusFromError(error) });
        return;
      }
      this.set({ busy: false, status: statusFromError(error) });
    }
  }

  /** The conflict banner's Use theirs: asks, then drops the draft or the change waiting for the computer. */
  useTheirs(): void {
    const conflict = this.snapshot.conflict;
    if (!conflict) return;
    this.askConfirm(
      { id: "use-theirs", text: "Discard your changes?", confirmLabel: "Discard", cancelLabel: "Keep editing" },
      async () => {
        if (conflict.origin === "overlay") {
          const entry = this.overlayEntries.find((candidate) => candidate.path === conflict.path);
          if (entry) {
            try {
              await this.api.discard(entry.path, entry.revision);
            } catch (error) {
              this.set({ status: statusFromError(error) });
              return;
            }
          }
        }
        this.stopTimer("probe");
        this.set({ edit: null, conflict: null });
        await this.loadFile(conflict.path);
        void this.loadListing(this.snapshot.directory);
      },
    );
  }

  private scheduleProbe(): void {
    this.stopTimer("probe");
    const edit = this.snapshot.edit;
    if (!this.snapshot.active || !edit || !edit.loadedFromLive || edit.piChanged) return;
    this.startTimer("probe", EDIT_PROBE_INTERVAL_MS, () => void this.probe());
  }

  private async probe(): Promise<void> {
    const edit = this.snapshot.edit;
    if (!edit || !this.snapshot.active) return;
    try {
      const { stat } = await this.api.stat(edit.path);
      const current = this.snapshot.edit;
      if (!current || current.path !== edit.path) return;
      if (changedSinceLoad(current, { size: stat.entry.size, modified_at: stat.entry.modified_at })) {
        this.set({ edit: { ...current, piChanged: true } });
        return;
      }
    } catch {
      this.scheduleProbe();
      return;
    }
    this.scheduleProbe();
  }

  /**
   * The tool cards of the running turn, as touched files. A write or edit of
   * the open file that appears, or finishes, while it is being edited is a
   * change Pi made; an unedited open file or listing is read again.
   */
  noteTouched(touched: readonly TouchedFile[]): void {
    const changed: string[] = [];
    for (const file of touched) {
      if (file.lastWriteSignature === null) continue;
      if (this.seenWriteSignatures.get(file.path) !== file.lastWriteSignature) {
        this.seenWriteSignatures.set(file.path, file.lastWriteSignature);
        if (this.touchedBaselined) changed.push(file.path);
      }
    }
    this.touchedBaselined = true;
    const edit = this.snapshot.edit;
    for (const path of changed) {
      if (edit && edit.path === path) {
        this.set({ edit: { ...(this.snapshot.edit ?? edit), piChanged: true } });
      } else if (this.snapshot.openFile === path && !edit && !this.snapshot.conflict) {
        void this.loadFile(path);
      } else if (!this.snapshot.openFile && parentDirectory(path) === this.snapshot.directory) {
        void this.loadListing(this.snapshot.directory);
      }
    }
  }

  /** Creates an empty file in the current folder and opens it for editing. */
  async createFile(name: string): Promise<void> {
    const problem = entryNameProblem(name);
    if (problem) {
      this.set({ status: { tone: "error", text: problem, detail: null } });
      return;
    }
    const path = childPath(this.snapshot.directory, name);
    this.set({ busy: true, status: null });
    try {
      const result = await this.api.write(path, "", { type: "if_none_match" });
      this.set({ busy: false, edit: null, conflict: null, openFile: path });
      await this.loadFile(path);
      void this.loadListing(this.snapshot.directory);
      const viewer = this.snapshot.viewer;
      if (viewer && viewer.status === "ready") {
        this.set({ edit: startNewFileSession(path, result.sha256, result.modified_at, result.source === "live") });
        this.scheduleProbe();
      }
    } catch (error) {
      this.set({ busy: false, status: statusFromError(error) });
    }
  }

  private async hashFor(path: string): Promise<string> {
    const { stat, etagSha256 } = await this.api.stat(path);
    const entry = stat.entry;
    const hash = etagSha256 ?? (entry.kind === "directory" ? entry.tree_sha256 : entry.sha256);
    if (hash === null) throw new FilesApiError(502, "owner_error", "no hash for that path");
    return hash;
  }

  private async countDescendants(path: string): Promise<{ files: number; folders: number; truncated: boolean }> {
    const queue = [path];
    let files = 0;
    let folders = 0;
    while (queue.length > 0) {
      const next = queue.shift() as string;
      const listing = await this.api.list(next);
      if (listing.stale) throw new FilesApiError(503, "owner_timeout", "stale");
      for (const entry of listing.entries) {
        if (entry.kind === "directory") {
          folders += 1;
          queue.push(entry.path);
        } else {
          files += 1;
        }
        if (files + folders > DESCENDANT_WALK_LIMIT) return { files, folders, truncated: true };
      }
      if (listing.truncated) return { files, folders, truncated: true };
    }
    return { files, folders, truncated: false };
  }

  /**
   * Asks to delete a file, a link or a folder. A folder with things in it
   * names the count and is offered only to the owner role.
   */
  async requestDelete(path: string, directory: boolean): Promise<void> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!directory) {
      this.askConfirm(
        { id: "delete", text: `Delete ${name}?`, confirmLabel: "Delete", cancelLabel: "Cancel" },
        async () => this.performDelete(path, false),
      );
      return;
    }
    this.set({ busy: true, status: null });
    let counts: { files: number; folders: number; truncated: boolean };
    try {
      counts = await this.countDescendants(path);
    } catch (error) {
      this.set({ busy: false, status: statusFromError(error) });
      return;
    }
    this.set({ busy: false });
    const total = counts.files + counts.folders;
    if (total === 0) {
      this.askConfirm(
        { id: "delete", text: `Delete ${name}?`, confirmLabel: "Delete", cancelLabel: "Cancel" },
        async () => this.performDelete(path, false),
      );
      return;
    }
    if (this.snapshot.role !== "owner") {
      this.askConfirm(
        {
          id: "delete-blocked",
          text: `${name} has files in it. Only the organization owner can delete a folder that is not empty.`,
          confirmLabel: null,
          cancelLabel: "Close",
        },
        async () => undefined,
      );
      return;
    }
    this.askConfirm(
      {
        id: "delete",
        text: counts.truncated ? `Delete ${name} and everything in it?` : `Delete ${name} and the ${describeCounts(counts)} in it?`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
      },
      async () => this.performDelete(path, true),
    );
  }

  private async performDelete(path: string, recursive: boolean): Promise<void> {
    this.set({ busy: true, status: null });
    try {
      const hash = await this.hashFor(path);
      const result = await this.api.remove(path, hash, recursive);
      const open = this.snapshot.openFile;
      if (open && (open === path || open.startsWith(`${path}/`))) this.performNavigation({ kind: "directory", path: parentDirectory(path) });
      this.set({
        busy: false,
        status: {
          tone: "ok",
          text: result.source === "overlay" ? "Deleted. This will be applied when the computer starts" : "Deleted on the computer",
          detail: result.backed_up ? null : "Not yet in the saved copy",
        },
      });
      await this.loadListing(this.snapshot.directory);
    } catch (error) {
      this.set({ busy: false, status: statusFromError(error) });
    }
  }

  /** Renames an entry inside its own folder. */
  async renameEntry(path: string, newName: string): Promise<void> {
    const problem = entryNameProblem(newName);
    if (problem) {
      this.set({ status: { tone: "error", text: problem, detail: null } });
      return;
    }
    const target = childPath(parentDirectory(path), newName);
    this.set({ busy: true, status: null });
    try {
      const hash = await this.hashFor(path);
      const result = await this.api.move(path, target, hash);
      this.set({
        busy: false,
        status: {
          tone: "ok",
          text:
            result.source === "overlay"
              ? `Renamed to ${newName.trim()}. This will be applied when the computer starts`
              : `Renamed to ${newName.trim()} on the computer`,
          detail: result.backed_up ? null : "Not yet in the saved copy",
        },
      });
      await this.loadListing(this.snapshot.directory);
    } catch (error) {
      this.set({ busy: false, status: statusFromError(error) });
    }
  }

  /** Creates a folder in the current folder. */
  async makeFolder(name: string): Promise<void> {
    const problem = entryNameProblem(name);
    if (problem) {
      this.set({ status: { tone: "error", text: problem, detail: null } });
      return;
    }
    this.set({ busy: true, status: null });
    try {
      const result = await this.api.makeDirectory(childPath(this.snapshot.directory, name));
      this.set({
        busy: false,
        status: {
          tone: "ok",
          text:
            result.source === "overlay"
              ? `Folder ${name.trim()} created. It will be made when the computer starts`
              : `Folder ${name.trim()} created on the computer`,
          detail: result.backed_up ? null : "Not yet in the saved copy",
        },
      });
      await this.loadListing(this.snapshot.directory);
    } catch (error) {
      this.set({ busy: false, status: statusFromError(error) });
    }
  }

  /** Opens or closes the Pending changes list. */
  async setPendingOpen(open: boolean): Promise<void> {
    this.set({ pending: { ...this.snapshot.pending, open } });
    if (open) await this.reloadPending();
  }

  private async reloadPending(): Promise<void> {
    try {
      const entries = await this.api.pending();
      this.overlayEntries = entries;
      this.set({ pending: { ...this.snapshot.pending, entries: sortPendingChanges(entries), loaded: true } });
    } catch (error) {
      this.set({ status: statusFromError(error) });
    }
  }

  /** Asks before dropping one change waiting for the computer. */
  requestDiscardPending(path: string): void {
    const entry = this.overlayEntries.find((candidate) => candidate.path === path);
    if (!entry) return;
    this.askConfirm(
      {
        id: "discard-pending",
        text: `Discard this change? ${describePendingChange(entry)}`,
        confirmLabel: "Discard",
        cancelLabel: "Keep",
      },
      async () => {
        try {
          await this.api.discard(entry.path, entry.revision);
          await this.reloadPending();
          await this.loadListing(this.snapshot.directory);
          const open = this.snapshot.openFile;
          if (open && !this.snapshot.edit) await this.loadFile(open);
        } catch (error) {
          this.set({ status: statusFromError(error) });
        }
      },
    );
  }

  /** Tries the failed read or change again, by hand. */
  retry(): void {
    this.refresh();
  }
}

function statusFromError(error: unknown): StatusMessage {
  const view = describeFilesError(error);
  return {
    tone: view.tone === "error" ? "error" : "notice",
    text: view.title,
    detail: null,
    reloadInstead: view.reloadInstead,
    retryable: view.retryable,
  };
}

function describeCounts(counts: { files: number; folders: number; truncated: boolean }): string {
  const parts: string[] = [];
  if (counts.files > 0) parts.push(`${counts.files} ${counts.files === 1 ? "file" : "files"}`);
  if (counts.folders > 0) parts.push(`${counts.folders} ${counts.folders === 1 ? "folder" : "folders"}`);
  return parts.join(" and ");
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
