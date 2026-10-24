export type FakeBotBoardRow = Record<string, string>;

export type FakeBotBoardRequest = { method: string; path: string; query: Record<string, string> };

export type FakeBoardServiceMode = "ok" | "unreachable" | "not_enabled";

type FakeBoard = {
  botId: string;
  name: string;
  cards: Array<Record<string, unknown>>;
  indexBehind: boolean;
  hiddenFromMember: boolean;
};

const DEFAULT_WORKFLOW: Record<string, string[]> = {
  backlog: ["open", "closed"],
  open: ["in_progress", "closed", "backlog"],
  in_progress: ["open", "blocked", "closed"],
  blocked: ["in_progress", "closed"],
  closed: ["open"],
};

/** The configuration the Kanbus default generates, in the shape the front door's overview route returns it. */
export function defaultBoardConfiguration(): Record<string, unknown> {
  return {
    actor_id: "chatticus:user:fake",
    project_key: "kanbus",
    project_directory: "project",
    hierarchy: ["initiative", "epic", "task", "sub-task"],
    types: ["bug", "story", "chore"],
    workflows: { default: DEFAULT_WORKFLOW },
    initial_status: "open",
    priorities: {
      "0": { name: "critical", color: "bright_red" },
      "1": { name: "high", color: "bright_yellow" },
      "2": { name: "medium", color: "bright_blue" },
      "3": { name: "low", color: "white" },
      "4": { name: "trivial", color: "bright_black" },
    },
    default_priority: 2,
    statuses: [
      { key: "backlog", name: "Backlog", category: "To do" },
      { key: "open", name: "Open", category: "To do" },
      { key: "in_progress", name: "In Progress", category: "In progress" },
      { key: "blocked", name: "Blocked", category: "In progress" },
      { key: "closed", name: "Closed", category: "Done" },
    ],
    categories: [{ name: "To do" }, { name: "In progress" }, { name: "Done" }],
    type_colors: { initiative: "bright_blue", epic: "magenta", task: "blue", "sub-task": "cyan", bug: "red", story: "green", chore: "white" },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function issueOf(botId: string, row: FakeBotBoardRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    description: "",
    type: row.type ? row.type : "task",
    status: row.status ? row.status : "open",
    priority: row.priority ? Number(row.priority) : 2,
    assignee: null,
    creator: `chatticus:bot:${botId}`,
    parent: row.parent ? row.parent : null,
    labels: row.labels ? row.labels.split(",").map((label) => label.trim()).filter((label) => label !== "") : [],
    dependencies: [],
    comments: [],
    created_at: "2026-10-12T09:00:00.000Z",
    updated_at: "2026-10-12T09:00:00.000Z",
    closed_at: null,
    custom: {},
  };
}

/**
 * A fake front door for the bot board routes of `conversation/src/http/routes/bot-boards.ts` and the bot list route,
 * with the same response shapes and error codes. It keeps the cards of each bot, pages them by cursor, and can be told
 * to lag behind, to be unreachable, to have no board service, or to hide a board from the member.
 */
export class FakeBotBoards {
  readonly requests: FakeBotBoardRequest[] = [];
  mode: FakeBoardServiceMode = "ok";
  private readonly boards = new Map<string, FakeBoard>();

  addBot(botId: string, name: string): void {
    if (!this.boards.has(botId)) this.boards.set(botId, { botId, name, cards: [], indexBehind: false, hiddenFromMember: false });
  }

  removeBot(botId: string): void {
    this.boards.delete(botId);
  }

  botIdNamed(name: string): string {
    for (const board of this.boards.values()) if (board.name === name) return board.botId;
    throw new Error(`no bot named ${name}`);
  }

  addCards(botId: string, rows: FakeBotBoardRow[]): void {
    const board = this.requireBoard(botId);
    for (const row of rows) board.cards.push(issueOf(botId, row));
  }

  setIndexBehind(botId: string, behind: boolean): void {
    this.requireBoard(botId).indexBehind = behind;
  }

  hideFromMember(botId: string): void {
    this.requireBoard(botId).hiddenFromMember = true;
  }

  private requireBoard(botId: string): FakeBoard {
    const board = this.boards.get(botId);
    if (!board) throw new Error(`no bot ${botId}`);
    return board;
  }

  handles(input: RequestInfo | URL): boolean {
    const path = new URL(String(input), "http://panel.test").pathname;
    return /^\/api\/orgs\/[^/]+\/(bots\/[^/]+\/board|users\/[^/]+\/bots$)/.test(path);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://panel.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ method, path: url.pathname, query });
    const listMatch = /^\/api\/orgs\/([^/]+)\/users\/([^/]+)\/bots$/.exec(url.pathname);
    if (listMatch) {
      const bots = [...this.boards.values()].map((board) => ({ bot_id: board.botId, tenant_id: listMatch[1], user_id: listMatch[2], name: board.name, memory: {} }));
      return json(200, { bots });
    }
    const boardMatch = /^\/api\/orgs\/([^/]+)\/bots\/([^/]+)\/board(\/cards)?$/.exec(url.pathname);
    if (!boardMatch || method !== "GET") return json(404, { detail: "The board was not found.", code: "not_found", kind: "not_found" });
    if (this.mode === "not_enabled") return json(404, { detail: "This deployment has no board service.", code: "board_service_not_enabled" });
    if (this.mode === "unreachable") {
      return json(502, { detail: "The board service did not confirm the request.", code: "board_service_unavailable", kind: "unavailable" });
    }
    const board = this.boards.get(decodeURIComponent(boardMatch[2]));
    if (!board || board.hiddenFromMember) return json(404, { detail: "The board was not found.", code: "not_found", kind: "not_found" });
    const limit = Math.min(Number(query.limit ?? "100"), 100);
    const offset = query.cursor ? Number(query.cursor) : 0;
    const visible = board.indexBehind ? board.cards.slice(0, Math.max(0, board.cards.length - 1)) : board.cards;
    const page = visible.slice(offset, offset + limit);
    const nextCursor = offset + limit < visible.length ? String(offset + limit) : null;
    const entries = page.map((issue) => ({ issue: structuredClone(issue), revision: "r1" }));
    if (boardMatch[3]) return json(200, { cards: entries, next_cursor: nextCursor, catalog_pending: board.indexBehind });
    return json(200, {
      tenant_id: decodeURIComponent(boardMatch[1]),
      bot_id: board.botId,
      bot_name: board.name,
      configuration: defaultBoardConfiguration(),
      cards: entries,
      next_cursor: nextCursor,
      catalog_pending: board.indexBehind,
    });
  };
}
