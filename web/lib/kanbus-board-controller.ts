import type { KanbanConfig, KanbanIssue } from "@kanbus/ui";

import type { ComputerFilesApi } from "./computer-files-api";
import {
  FilesApiError,
  WORKSPACE_ROOT,
  describeFilesError,
  describeSourceLine,
  type FileEntry,
  type FileListing,
  type SourceLine,
} from "./computer-files";
import {
  KANBUS_ISSUES_DIRECTORY,
  KANBUS_ISSUE_FILE_LIMIT,
  buildKanbusBoardConfig,
  chooseIssueFilesToRead,
  parseKanbusIssueFile,
} from "./kanbus-board";

/** The two file routes the board uses. Reading is the only thing the board does to the workspace. */
export type KanbusBoardApi = Pick<ComputerFilesApi, "list" | "read">;

export const KANBUS_BOARD_READ_CONCURRENCY = 4;
export const KANBUS_BOARD_SUBDIRECTORY_SCAN_LIMIT = 12;
export const KANBUS_BOARD_REFRESH_AFTER_MS = 30000;

const MISSING_DIRECTORY_CODES: ReadonlySet<string> = new Set(["not_found", "parent_missing", "not_a_directory"]);

export type KanbusBoardPhase =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty"; title: string }
  | { status: "error"; title: string }
  | {
      status: "ready";
      boardName: string;
      issuesDirectory: string;
      issues: readonly KanbanIssue[];
      config: KanbanConfig;
      issueCount: number;
      skippedFileCount: number;
      unreadableFileCount: number;
      source: SourceLine;
    };

/** What a look for the workspace's Kanbus project found, without reading any issue file. */
export type KanbusProjectDiscovery = { status: "found"; boardName: string } | { status: "none" } | { status: "error"; title: string };

export type KanbusBoardSnapshot = {
  phase: KanbusBoardPhase;
  refreshing: boolean;
};

export type KanbusBoardControllerOptions = {
  api: KanbusBoardApi;
  now?: () => number;
  readConcurrency?: number;
  issueFileLimit?: number;
};

type CachedIssueFile = { sha256: string | null; issue: KanbanIssue | null; unreadable: boolean };

function isMissingDirectory(error: unknown): boolean {
  return error instanceof FilesApiError && error.code !== null && MISSING_DIRECTORY_CODES.has(error.code);
}

function boardNameOf(issuesDirectory: string): string {
  const parts = issuesDirectory.split("/").filter((part) => part !== "");
  const projectRoot = parts.slice(0, -2);
  return projectRoot.length > 1 ? projectRoot[projectRoot.length - 1] : "Workspace";
}

/**
 * The behavior of the Kanbus board panel with no React and no DOM: find a Kanbus project in the workspace, read its
 * issue files through the member file routes, and hand them to the Kanbus board component. A file whose hash has not changed since
 * the last load is not read again, so a refresh costs one listing plus the files that changed.
 */
export class KanbusBoardController {
  private readonly api: KanbusBoardApi;
  private readonly now: () => number;
  private readonly readConcurrency: number;
  private readonly issueFileLimit: number;
  private readonly listeners = new Set<() => void>();
  private readonly cache = new Map<string, CachedIssueFile>();
  private snapshot: KanbusBoardSnapshot = { phase: { status: "idle" }, refreshing: false };
  private loadSequence = 0;
  private loadedAtMs: number | null = null;
  private loading = false;

  constructor(options: KanbusBoardControllerOptions) {
    this.api = options.api;
    this.now = options.now ?? Date.now;
    this.readConcurrency = options.readConcurrency ?? KANBUS_BOARD_READ_CONCURRENCY;
    this.issueFileLimit = options.issueFileLimit ?? KANBUS_ISSUE_FILE_LIMIT;
  }

  getSnapshot = (): KanbusBoardSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Tells the controller whether the board tab is showing. The first showing loads; a later one refreshes when the board is old. */
  setActive(active: boolean): void {
    if (!active) return;
    const neverLoaded = this.loadedAtMs === null && !this.loading;
    const gone = this.loadedAtMs !== null && this.now() - this.loadedAtMs >= KANBUS_BOARD_REFRESH_AFTER_MS;
    if (neverLoaded || gone) void this.refresh();
  }

  /** Stops loads in flight from changing the snapshot. */
  dispose(): void {
    this.loadSequence += 1;
    this.loading = false;
  }

  /** Looks for the Kanbus project in the workspace with one or a few listings and no file reads, to name it in a picker. */
  async discover(): Promise<KanbusProjectDiscovery> {
    try {
      const found = await this.findIssuesListing();
      return found === null ? { status: "none" } : { status: "found", boardName: boardNameOf(found.directory) };
    } catch (error) {
      return { status: "error", title: describeFilesError(error).title };
    }
  }

  /** Reads the board again. */
  async refresh(): Promise<void> {
    const sequence = (this.loadSequence += 1);
    this.loading = true;
    const hasBoard = this.snapshot.phase.status === "ready";
    this.publish(hasBoard ? { phase: this.snapshot.phase, refreshing: true } : { phase: { status: "loading" }, refreshing: false });
    try {
      const phase = await this.load(sequence);
      if (sequence !== this.loadSequence) return;
      this.loading = false;
      this.loadedAtMs = this.now();
      this.publish({ phase, refreshing: false });
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      this.loading = false;
      this.loadedAtMs = null;
      this.publish({ phase: { status: "error", title: describeFilesError(error).title }, refreshing: false });
    }
  }

  private publish(snapshot: KanbusBoardSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  private async findIssuesListing(): Promise<{ directory: string; listing: FileListing } | null> {
    const rootCandidate = `${WORKSPACE_ROOT}/${KANBUS_ISSUES_DIRECTORY}`;
    try {
      return { directory: rootCandidate, listing: await this.api.list(rootCandidate) };
    } catch (error) {
      if (!isMissingDirectory(error)) throw error;
    }
    const workspace = await this.api.list(WORKSPACE_ROOT);
    const folders = workspace.entries
      .filter((entry) => entry.kind === "directory")
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, KANBUS_BOARD_SUBDIRECTORY_SCAN_LIMIT);
    for (const folder of folders) {
      const candidate = `${folder.path}/${KANBUS_ISSUES_DIRECTORY}`;
      try {
        return { directory: candidate, listing: await this.api.list(candidate) };
      } catch (error) {
        if (!isMissingDirectory(error)) throw error;
      }
    }
    return null;
  }

  private async readIssueFile(entry: FileEntry): Promise<CachedIssueFile> {
    const cached = this.cache.get(entry.path);
    if (cached !== undefined && cached.sha256 !== null && cached.sha256 === entry.sha256) return cached;
    let result: CachedIssueFile;
    try {
      const content = await this.api.read(entry.path);
      const usable = !content.binary && !content.masked && !content.truncated;
      const issue = usable ? parseKanbusIssueFile(content.content) : null;
      result = { sha256: entry.sha256, issue, unreadable: issue === null };
    } catch (error) {
      if (error instanceof FilesApiError && error.code === "rate_limited") throw error;
      result = { sha256: null, issue: null, unreadable: true };
    }
    this.cache.set(entry.path, result);
    return result;
  }

  private async readAll(entries: readonly FileEntry[], sequence: number): Promise<CachedIssueFile[]> {
    const results: CachedIssueFile[] = new Array(entries.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length && sequence === this.loadSequence) {
        const index = next;
        next += 1;
        results[index] = await this.readIssueFile(entries[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.readConcurrency, entries.length) }, worker));
    return results;
  }

  private async load(sequence: number): Promise<KanbusBoardPhase> {
    const found = await this.findIssuesListing();
    if (found === null) return { status: "empty", title: "No Kanbus project in the workspace yet" };
    const { chosen, skippedCount } = chooseIssueFilesToRead(found.listing.entries, this.issueFileLimit);
    const results = await this.readAll(chosen, sequence);
    const livePaths = new Set(chosen.map((entry) => entry.path));
    for (const path of [...this.cache.keys()]) if (!livePaths.has(path)) this.cache.delete(path);
    const issues = results.flatMap((result) => (result?.issue ? [result.issue] : []));
    return {
      status: "ready",
      boardName: boardNameOf(found.directory),
      issuesDirectory: found.directory,
      issues,
      config: buildKanbusBoardConfig(issues),
      issueCount: issues.length,
      skippedFileCount: skippedCount,
      unreadableFileCount: results.filter((result) => result?.unreadable).length,
      source: describeSourceLine(found.listing, null, this.now()),
    };
  }
}
