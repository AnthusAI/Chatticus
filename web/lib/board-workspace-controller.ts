import type { KanbanConfig, KanbanIssue } from "@kanbus/ui";

import type { Bot } from "./api";
import { kanbanConfigFromBotBoardConfiguration, kanbanIssueFromBotBoardIssue } from "./bot-board-adapter";
import { BOARD_SERVICE_NOT_ENABLED_CODE, BotBoardsApiError, type BotBoardCard, type BotBoardsApi } from "./bot-boards-api";
import {
  KanbusBoardController,
  type KanbusBoardApi,
  type KanbusBoardSnapshot,
  type KanbusProjectDiscovery,
} from "./kanbus-board-controller";
import { KANBUS_ISSUE_FILE_LIMIT } from "./kanbus-board";

/** The most cards of a bot board one load reads. */
export const BOT_BOARD_CARD_LIMIT = 200;
export const BOT_BOARD_PAGE_SIZE = 100;
export const BOARD_WORKSPACE_REFRESH_AFTER_MS = 30000;

export const BOT_BOARD_SOURCE_TEXT = "Saved to the cloud";
export const BOT_BOARDS_NOT_ENABLED_TEXT = "Bot boards are not available in this environment yet";
export const BOT_BOARDS_UNAVAILABLE_TEXT = "The bot boards are not available right now";
export const BOT_BOARD_GONE_TEXT = "That bot board is no longer there";
export const BOT_WITHOUT_BOARD_NOTE = "no board yet";
export const BOT_WITHOUT_BOARD_HINT = "Its board will show here once it has one.";
export const BOT_BOARD_BEHIND_TEXT = "Some recent changes may not be shown yet. Refresh to look again.";
export const NO_PROJECT_TEXT = "No Kanbus project in the workspace yet";
export const PROJECT_EMPTY_HINT = "A Kanbus project keeps one JSON file per issue under project/issues in a folder of the workspace.";

/** Which board the member is looking at. */
export type BoardSelection = { kind: "project" } | { kind: "bot"; botId: string };

/** Where the picker's last choice is remembered between visits. Reads and writes may fail silently. */
export type BoardSelectionStore = {
  read: () => string | null;
  write: (value: string) => void;
};

/** A line under the board name, with the test id that finds it. */
export type BoardNote = { testId: string; text: string };

/** What the board area shows: a message, or a board drawn by the Kanbus component. */
export type BoardView =
  | { status: "loading"; message: string }
  | { status: "empty"; title: string; hint: string | null }
  | { status: "error"; title: string }
  | {
      status: "ready";
      kind: "project" | "bot";
      kindLabel: string;
      title: string;
      issues: readonly KanbanIssue[];
      config: KanbanConfig;
      countText: string;
      sourceText: string;
      notes: readonly BoardNote[];
    };

/** The picker: what each section lists, or the one line it says instead. */
export type BoardPicker = {
  open: boolean;
  projects: { entries: Array<{ name: string }>; message: string | null };
  bots: { entries: Array<{ botId: string; name: string; note: string | null }>; message: string | null };
};

export type BoardWorkspaceSnapshot = {
  selection: BoardSelection;
  picker: BoardPicker;
  view: BoardView;
  refreshing: boolean;
};

export type BoardWorkspaceControllerOptions = {
  filesApi: KanbusBoardApi;
  botBoardsApi: BotBoardsApi;
  listBots: () => Promise<Bot[]>;
  selectionStore: BoardSelectionStore;
  now?: () => number;
};

type BotBoardState =
  | { status: "loading"; previous: BoardView | null }
  | { status: "done"; view: BoardView; loadedAtMs: number };

type BotListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "listed"; bots: Array<{ botId: string; name: string }> };

function countText(count: number): string {
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

function selectionKey(selection: BoardSelection): string {
  return selection.kind === "project" ? "project" : `bot:${selection.botId}`;
}

function selectionOfKey(key: string | null): BoardSelection | null {
  if (key === "project") return { kind: "project" };
  if (key !== null && key.startsWith("bot:") && key.length > 4) return { kind: "bot", botId: key.slice(4) };
  return null;
}

/**
 * The Board tab with no React and no DOM: a picker over the Kanbus project in the computer's workspace (read through the
 * member file routes by `KanbusBoardController`) and the boards of the organization's bots (read through the front door's
 * bot board routes). Whichever is picked, the result is one `BoardView` that one frame draws with the Kanbus component.
 * The controller only reads.
 */
export class BoardWorkspaceController {
  private readonly project: KanbusBoardController;
  private readonly botBoardsApi: BotBoardsApi;
  private readonly listBots: () => Promise<Bot[]>;
  private readonly selectionStore: BoardSelectionStore;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly botBoards = new Map<string, BotBoardState>();
  private readonly botSequences = new Map<string, number>();
  private readonly boardPresence = new Map<string, "has" | "none">();
  private selection: BoardSelection = { kind: "project" };
  private chosenByMember = false;
  private pickerOpen = false;
  private discovery: KanbusProjectDiscovery | null = null;
  private botList: BotListState = { status: "loading" };
  private boardServiceEnabled: boolean | null = null;
  private started = false;
  private generation = 0;
  private startedAtMs: number | null = null;
  private snapshot: BoardWorkspaceSnapshot;

  constructor(options: BoardWorkspaceControllerOptions) {
    this.project = new KanbusBoardController({ api: options.filesApi, ...(options.now ? { now: options.now } : {}) });
    this.botBoardsApi = options.botBoardsApi;
    this.listBots = options.listBots;
    this.selectionStore = options.selectionStore;
    this.now = options.now ?? Date.now;
    const remembered = selectionOfKey(this.readRemembered());
    if (remembered !== null) {
      this.selection = remembered;
      this.chosenByMember = true;
    }
    this.snapshot = this.compute();
    this.project.subscribe(() => {
      this.afterProjectChange();
      this.publish();
    });
  }

  getSnapshot = (): BoardWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Tells the controller whether the Board tab is showing. The first showing loads everything; a later one refreshes an old board. */
  setActive(active: boolean): void {
    if (!active) return;
    if (!this.started) {
      this.started = true;
      this.startedAtMs = this.now();
      void this.loadEverything();
      return;
    }
    if (this.startedAtMs !== null && this.now() - this.startedAtMs >= BOARD_WORKSPACE_REFRESH_AFTER_MS) {
      this.startedAtMs = this.now();
      void this.refresh();
    }
  }

  /** Stops loads in flight from changing the snapshot. */
  dispose(): void {
    this.generation += 1;
    this.started = false;
    this.project.dispose();
    for (const [botId, sequence] of this.botSequences) this.botSequences.set(botId, sequence + 1);
  }

  /** Opens the picker and looks for bots again, so a bot made since the last look is listed. */
  openPicker(): void {
    this.pickerOpen = true;
    this.publish();
    void this.loadBotList();
  }

  closePicker(): void {
    this.pickerOpen = false;
    this.publish();
  }

  /** Shows another board and remembers the choice. */
  select(selection: BoardSelection): void {
    this.selection = selection;
    this.chosenByMember = true;
    this.pickerOpen = false;
    this.writeRemembered(selectionKey(selection));
    this.publish();
    this.loadSelected();
  }

  /** Reads the board on show again, and the list of bots. */
  async refresh(): Promise<void> {
    const bots = this.loadBotList();
    const board = this.selection.kind === "project" ? this.project.refresh() : this.loadBotBoard(this.selection.botId);
    await Promise.all([bots, board]);
  }

  private readRemembered(): string | null {
    try {
      return this.selectionStore.read();
    } catch {
      return null;
    }
  }

  private writeRemembered(value: string): void {
    try {
      this.selectionStore.write(value);
    } catch {
      return;
    }
  }

  private async loadEverything(): Promise<void> {
    const bots = this.loadBotList();
    const discovery = this.discoverProject();
    this.loadSelected();
    await Promise.all([bots, discovery]);
  }

  private loadSelected(): void {
    if (this.selection.kind === "project") {
      this.project.setActive(true);
      return;
    }
    void this.loadBotBoard(this.selection.botId);
  }

  private async discoverProject(): Promise<void> {
    const generation = this.generation;
    const discovery = await this.project.discover();
    if (generation !== this.generation) return;
    this.discovery = discovery;
    this.publish();
  }

  private afterProjectChange(): void {
    const phase = this.project.getSnapshot().phase;
    if (phase.status === "ready") this.discovery = { status: "found", boardName: phase.boardName };
    if (phase.status === "empty") this.discovery = { status: "none" };
    this.moveOffEmptyProject();
  }

  private moveOffEmptyProject(): void {
    if (this.chosenByMember || this.selection.kind !== "project") return;
    if (this.discovery?.status !== "none" || this.botList.status !== "listed" || this.boardServiceEnabled === false) return;
    const first = this.botList.bots.find((bot) => this.boardPresence.get(bot.botId) !== "none");
    if (first === undefined) return;
    this.selection = { kind: "bot", botId: first.botId };
    this.loadSelected();
  }

  private async loadBotList(): Promise<void> {
    const generation = this.generation;
    try {
      const bots = await this.listBots();
      if (generation !== this.generation) return;
      const entries = bots.map((bot) => ({ botId: bot.bot_id, name: bot.name })).sort((left, right) => left.name.localeCompare(right.name));
      this.botList = { status: "listed", bots: entries };
    } catch {
      if (generation !== this.generation) return;
      this.botList = { status: "error" };
      this.publish();
      return;
    }
    this.publish();
    await this.probeBoards();
    if (generation !== this.generation) return;
    this.moveOffEmptyProject();
    this.publish();
  }

  private async probeBoards(): Promise<void> {
    if (this.botList.status !== "listed" || this.boardServiceEnabled === false) return;
    const generation = this.generation;
    const bots = this.botList.bots;
    for (const botId of [...this.boardPresence.keys()]) {
      if (!bots.some((bot) => bot.botId === botId)) this.boardPresence.delete(botId);
    }
    const unknownOrMissing = bots.filter((bot) => this.boardPresence.get(bot.botId) !== "has");
    await Promise.all(
      unknownOrMissing.map(async (bot) => {
        try {
          await this.botBoardsApi.overview(bot.botId, { limit: 1 });
          if (generation === this.generation) {
            this.boardServiceEnabled = true;
            this.boardPresence.set(bot.botId, "has");
          }
        } catch (error) {
          if (generation !== this.generation) return;
          if (error instanceof BotBoardsApiError && error.code === BOARD_SERVICE_NOT_ENABLED_CODE) this.boardServiceEnabled = false;
          else if (error instanceof BotBoardsApiError && error.status === 404) this.boardPresence.set(bot.botId, "none");
          else this.boardPresence.delete(bot.botId);
        }
      }),
    );
  }

  private botNameOf(botId: string): string | null {
    return this.botList.status === "listed" ? (this.botList.bots.find((bot) => bot.botId === botId)?.name ?? null) : null;
  }

  private async loadBotBoard(botId: string): Promise<void> {
    const generation = this.generation;
    const sequence = (this.botSequences.get(botId) ?? 0) + 1;
    this.botSequences.set(botId, sequence);
    const existing = this.botBoards.get(botId);
    this.botBoards.set(botId, { status: "loading", previous: existing?.status === "done" ? existing.view : null });
    this.publish();
    let view: BoardView;
    try {
      view = await this.readBotBoard(botId);
    } catch (error) {
      view = this.viewOfBotBoardFailure(error, botId);
    }
    if (generation !== this.generation || this.botSequences.get(botId) !== sequence) return;
    this.botBoards.set(botId, { status: "done", view, loadedAtMs: this.now() });
    this.publish();
  }

  private viewOfBotBoardFailure(error: unknown, botId: string): BoardView {
    if (error instanceof BotBoardsApiError) {
      if (error.code === BOARD_SERVICE_NOT_ENABLED_CODE) {
        this.boardServiceEnabled = false;
        return { status: "empty", title: BOT_BOARDS_NOT_ENABLED_TEXT, hint: null };
      }
      if (error.status === 404) {
        this.boardPresence.set(botId, "none");
        return { status: "empty", title: `${this.botNameOf(botId) ?? "This bot"} has no board yet`, hint: BOT_WITHOUT_BOARD_HINT };
      }
      if (error.status === 403) return { status: "error", title: "You cannot open this board" };
    }
    return { status: "error", title: BOT_BOARDS_UNAVAILABLE_TEXT };
  }

  private async readBotBoard(botId: string): Promise<BoardView> {
    const overview = await this.botBoardsApi.overview(botId, { limit: BOT_BOARD_PAGE_SIZE });
    this.boardServiceEnabled = true;
    this.boardPresence.set(botId, "has");
    const cards: BotBoardCard[] = [...overview.cards];
    let cursor = overview.next_cursor;
    let behind = overview.catalog_pending;
    while (cursor !== null && cards.length < BOT_BOARD_CARD_LIMIT) {
      const page = await this.botBoardsApi.cards(botId, { limit: Math.min(BOT_BOARD_PAGE_SIZE, BOT_BOARD_CARD_LIMIT - cards.length), cursor });
      cards.push(...page.cards);
      cursor = page.next_cursor;
      behind = behind || page.catalog_pending;
    }
    const issues = cards.map((card) => kanbanIssueFromBotBoardIssue(card.issue));
    const botName = this.botNameOf(botId) ?? overview.bot_name;
    const notes: BoardNote[] = [];
    if (issues.length === 0) notes.push({ testId: "kanbus-board-note", text: `${botName} has nothing on its board yet` });
    if (cursor !== null) notes.push({ testId: "kanbus-board-limit", text: `Showing the first ${BOT_BOARD_CARD_LIMIT} cards of this board` });
    if (behind) notes.push({ testId: "kanbus-board-behind", text: BOT_BOARD_BEHIND_TEXT });
    return {
      status: "ready",
      kind: "bot",
      kindLabel: "Bot board",
      title: `${botName}'s board`,
      issues,
      config: kanbanConfigFromBotBoardConfiguration(overview.configuration, issues),
      countText: countText(issues.length),
      sourceText: BOT_BOARD_SOURCE_TEXT,
      notes,
    };
  }

  private viewOfProject(snapshot: KanbusBoardSnapshot): BoardView {
    const phase = snapshot.phase;
    switch (phase.status) {
      case "idle":
      case "loading":
        return { status: "loading", message: "Reading the board from the computer" };
      case "empty":
        return { status: "empty", title: phase.title, hint: PROJECT_EMPTY_HINT };
      case "error":
        return { status: "error", title: phase.title };
      case "ready": {
        const notes: BoardNote[] = [];
        if (phase.skippedFileCount > 0) {
          notes.push({
            testId: "kanbus-board-limit",
            text: `Showing the ${KANBUS_ISSUE_FILE_LIMIT} most recently changed of ${KANBUS_ISSUE_FILE_LIMIT + phase.skippedFileCount} issues`,
          });
        }
        if (phase.unreadableFileCount > 0) {
          notes.push({
            testId: "kanbus-board-unreadable",
            text: `${phase.unreadableFileCount} ${phase.unreadableFileCount === 1 ? "file" : "files"} could not be read as an issue`,
          });
        }
        return {
          status: "ready",
          kind: "project",
          kindLabel: "Project board",
          title: `${phase.boardName} board`,
          issues: phase.issues,
          config: phase.config,
          countText: countText(phase.issues.length),
          sourceText: phase.source.text,
          notes,
        };
      }
    }
  }

  private viewOfSelectedBot(botId: string): BoardView {
    if (this.botList.status === "listed" && this.botNameOf(botId) === null) {
      return { status: "empty", title: BOT_BOARD_GONE_TEXT, hint: null };
    }
    const state = this.botBoards.get(botId);
    if (state === undefined || (state.status === "loading" && state.previous === null)) {
      return { status: "loading", message: "Reading the board from the cloud" };
    }
    return state.status === "loading" ? (state.previous as BoardView) : state.view;
  }

  private pickerOfNow(): BoardPicker {
    const projects: BoardPicker["projects"] = { entries: [], message: null };
    if (this.discovery === null) projects.message = "Looking for Kanbus projects";
    else if (this.discovery.status === "found") projects.entries.push({ name: this.discovery.boardName });
    else if (this.discovery.status === "none") projects.message = NO_PROJECT_TEXT;
    else projects.message = this.discovery.title;
    const bots: BoardPicker["bots"] = { entries: [], message: null };
    if (this.boardServiceEnabled === false) bots.message = BOT_BOARDS_NOT_ENABLED_TEXT;
    else if (this.botList.status === "loading") bots.message = "Looking for bots";
    else if (this.botList.status === "error") bots.message = "The bots could not be listed";
    else if (this.botList.bots.length === 0) bots.message = "No bots yet";
    else bots.entries = this.botList.bots.map((bot) => ({ ...bot, note: this.boardPresence.get(bot.botId) === "none" ? BOT_WITHOUT_BOARD_NOTE : null }));
    return { open: this.pickerOpen, projects, bots };
  }

  private compute(): BoardWorkspaceSnapshot {
    const selection = this.selection;
    const botState = selection.kind === "bot" ? this.botBoards.get(selection.botId) : undefined;
    const refreshing = selection.kind === "project" ? this.project.getSnapshot().refreshing : botState?.status === "loading" && botState.previous !== null;
    return {
      selection,
      picker: this.pickerOfNow(),
      view: selection.kind === "project" ? this.viewOfProject(this.project.getSnapshot()) : this.viewOfSelectedBot(selection.botId),
      refreshing,
    };
  }

  private publish(): void {
    this.snapshot = this.compute();
    this.listeners.forEach((listener) => listener());
  }
}
