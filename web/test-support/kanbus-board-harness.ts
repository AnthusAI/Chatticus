import { createInterface } from "node:readline";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setIdTokenSourceForTests } from "../lib/api-auth";
import { computerFilesApiFor } from "../lib/computer-files-api";
import { listBots } from "../lib/api";
import { BoardWorkspaceController, type BoardSelection, type BoardSelectionStore } from "../lib/board-workspace-controller";
import { boardPickerLayoutFor } from "../lib/board-picker-layout";
import { botBoardsApiFor } from "../lib/bot-boards-api";
import { FakeBotBoards, type FakeBoardServiceMode } from "./bot-boards-fake";
import { FakeComputerFiles, type FakeMode } from "./computer-files-fake";
import { elementsWithClassOfMarkup, testElementsOfMarkup, textOfMarkup } from "./html-test-elements";

(globalThis as { React?: typeof React }).React = React;

const fake = new FakeComputerFiles();
const botBoards = new FakeBotBoards();
const realFakeFetch = fake.fetch;
let controller: BoardWorkspaceController | null = null;
let failEveryRequest = false;
let rememberedSelection: string | null = null;
let theme: "light" | "dark" = "light";
let panelWidth = 880;
const drawings: Array<{ kind: string; wrapperClass: string; columnClass: string; cardClass: string }> = [];
const computerRequestsSincePick: string[] = [];

const selectionStore: BoardSelectionStore = {
  read: () => rememberedSelection,
  write: (value) => {
    rememberedSelection = value;
  },
};

function botIdFor(name: string): string {
  return `bot-${name.toLowerCase()}`;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (botBoards.handles(input)) return botBoards.fetch(input, init);
  if (String(input).includes("/computer")) computerRequestsSincePick.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
  if (failEveryRequest) {
    return new Response(JSON.stringify({ error: "too_busy", message: "Too many file requests" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFakeFetch(input, init);
}) as typeof fetch;
setIdTokenSourceForTests(async () => "harness-token");

async function settle(): Promise<void> {
  for (let round = 0; round < 40; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function requireController(): BoardWorkspaceController {
  if (controller === null) throw new Error("the Board tab has not been opened");
  return controller;
}

type IssueRow = Record<string, string>;

function issueFileText(row: IssueRow): string {
  return JSON.stringify({
    id: row.id,
    title: row.title,
    type: row.type ? row.type : "task",
    status: row.status ? row.status : "open",
    priority: row.priority ? Number(row.priority) : 2,
    labels: row.labels ? row.labels.split(",").map((label) => label.trim()).filter((label) => label !== "") : [],
    parent: row.parent ? row.parent : undefined,
    updated_at: row.updated ? row.updated : undefined,
  });
}

function issuePath(project: string, id: string): string {
  return ["/workspace", project, "project", "issues", `${id}.json`].filter((part) => part !== "").join("/");
}

function seedIssues(project: string, rows: IssueRow[]): void {
  for (const row of rows) fake.seed("live", issuePath(project, row.id), issueFileText(row));
}

async function render() {
  const frame = await import("../components/workspace/KanbusBoardPanelFrame");
  const html = renderToStaticMarkup(
    createElement(frame.KanbusBoardPanelFrame, {
      snapshot: requireController().getSnapshot(),
      handlers: { onRefresh: () => undefined, onSelect: () => undefined, onTogglePicker: () => undefined },
      theme,
      layout: boardPickerLayoutFor(panelWidth),
    }),
  );
  const columns = elementsWithClassOfMarkup(html, "kb-column").map((column) => ({
    key: column.attributes["data-column-key"] ?? "",
    headerText: elementsWithClassOfMarkup(column.innerHtml, "kb-column-header")[0]?.text ?? "",
    cards: elementsWithClassOfMarkup(column.innerHtml, "issue-card").map((card) => ({
      id: card.attributes["data-issue-id"] ?? "",
      type: card.attributes["data-type"] ?? "",
      priority: card.attributes["data-priority"] ?? "",
      text: card.text,
    })),
  }));
  return { html, text: textOfMarkup(html), elements: testElementsOfMarkup(html), columns };
}

async function recordDrawing(kind: string): Promise<void> {
  const { html } = await render();
  drawings.push({
    kind,
    wrapperClass: (elementsWithClassOfMarkup(html, "chatticus-kanbus-board")[0]?.attributes.class ?? "").replace(/\bdark\b/, "").trim(),
    columnClass: elementsWithClassOfMarkup(html, "kb-column")[0]?.attributes.class ?? "",
    cardClass: elementsWithClassOfMarkup(html, "issue-card")[0]?.attributes.class ?? "",
  });
}

function botBoardRows(name: string, rows: IssueRow[]): IssueRow[] {
  const prefix = name.slice(0, 2).toLowerCase();
  return rows.map((row, index) => ({ ...row, id: row.id ? row.id : `${prefix}-${index + 1}` }));
}

type Command = { op: string } & Record<string, any>;

async function handle(command: Command): Promise<unknown> {
  switch (command.op) {
    case "init":
      return null;
    case "seed-issues":
      seedIssues(command.project, command.rows);
      return null;
    case "seed-text-file":
      fake.seed("live", command.path, command.content);
      return null;
    case "seed-many-issues": {
      for (let index = 1; index <= command.count; index += 1) {
        const id = `bulk-${String(index).padStart(3, "0")}`;
        const path = issuePath(command.project, id);
        fake.seed("live", path, issueFileText({ id, title: `Bulk issue ${index}`, status: command.status ?? "open" }));
        const node = fake.live.get(path);
        if (node) node.modifiedAtMs = fake.nowMs - index * 1000;
      }
      return null;
    }
    case "set-mode":
      fake.setMode(command.mode as FakeMode);
      return null;
    case "fail-every-request":
      failEveryRequest = command.value;
      return null;
    case "change-issue":
      fake.externalWrite(issuePath(command.project, command.id), issueFileText(command.row));
      return null;
    case "open": {
      const org = { tenantId: "anthus", userId: "ryan" };
      controller ??= new BoardWorkspaceController({
        filesApi: computerFilesApiFor(org),
        botBoardsApi: botBoardsApiFor(org),
        listBots: () => listBots(org),
        selectionStore,
        now: () => fake.nowMs,
      });
      controller.setActive(true);
      await settle();
      return null;
    }
    case "seed-bot-board": {
      const id = botIdFor(command.name);
      botBoards.addBot(id, command.name);
      botBoards.addCards(id, botBoardRows(command.name, command.rows));
      return null;
    }
    case "seed-bot-board-bulk": {
      const id = botIdFor(command.name);
      botBoards.addBot(id, command.name);
      botBoards.addCards(id, Array.from({ length: command.count }, (_, index) => ({ id: `bulk-${String(index + 1).padStart(3, "0")}`, title: `Bulk card ${index + 1}`, status: "open" })));
      return null;
    }
    case "add-bot-card": {
      const id = botIdFor(command.name);
      botBoards.addCards(id, [{ id: command.cardId, title: command.title, status: "open" }]);
      return null;
    }
    case "service-mode":
      botBoards.mode = command.mode as FakeBoardServiceMode;
      return null;
    case "seed-bot-without-board":
      botBoards.addBot(botIdFor(command.name), command.name);
      botBoards.removeBoard(botIdFor(command.name));
      return null;
    case "give-bot-board":
      botBoards.giveBoard(botIdFor(command.name));
      botBoards.addCards(botIdFor(command.name), botBoardRows(command.name, command.rows));
      return null;
    case "set-panel-width":
      panelWidth = command.width;
      return null;
    case "index-behind":
      botBoards.setIndexBehind(botIdFor(command.name), command.value);
      return null;
    case "remember-selection":
      rememberedSelection = command.kind === "project" ? "project" : `bot:${botIdFor(command.name)}`;
      return null;
    case "open-picker":
      requireController().openPicker();
      await settle();
      return null;
    case "close-picker":
      requireController().closePicker();
      return null;
    case "pick": {
      const selection: BoardSelection = command.kind === "project" ? { kind: "project" } : { kind: "bot", botId: botIdFor(command.name) };
      computerRequestsSincePick.length = 0;
      botBoards.requests.length = 0;
      requireController().select(selection);
      await settle();
      await recordDrawing(command.kind);
      return null;
    }
    case "set-theme":
      theme = command.value;
      return null;
    case "refresh":
      await requireController().refresh();
      await settle();
      return null;
    case "forget-requests":
      fake.requests.length = 0;
      return null;
    case "state": {
      const rendered = await render();
      return {
        ...rendered,
        requests: fake.requests.map((request) => ({ method: request.method, route: request.route, query: request.query })),
        botBoardRequests: botBoards.requests.map((request) => ({ method: request.method, path: request.path, query: request.query })),
        computerRequestsSincePick: [...computerRequestsSincePick],
        drawings,
      };
    }
    default:
      throw new Error(`unknown op ${command.op}`);
  }
}

const lines = createInterface({ input: process.stdin });
let queue: Promise<void> = Promise.resolve();
lines.on("line", (line) => {
  queue = queue.then(async () => {
    let reply: Record<string, unknown>;
    try {
      reply = { ok: true, result: await handle(JSON.parse(line) as Command) };
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
    }
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
});
lines.on("close", () => process.exit(0));
