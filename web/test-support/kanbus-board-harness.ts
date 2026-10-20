import { createInterface } from "node:readline";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setIdTokenSourceForTests } from "../lib/api-auth";
import { computerFilesApiFor } from "../lib/computer-files-api";
import { KanbusBoardController } from "../lib/kanbus-board-controller";
import { FakeComputerFiles, type FakeMode } from "./computer-files-fake";
import { testElementsOfMarkup, textOfMarkup } from "./html-test-elements";

(globalThis as { React?: typeof React }).React = React;

const fake = new FakeComputerFiles();
const realFakeFetch = fake.fetch;
let controller: KanbusBoardController | null = null;
let failEveryRequest = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

function requireController(): KanbusBoardController {
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
  const view = await import("../components/workspace/KanbusBoardPanelView");
  const html = renderToStaticMarkup(
    createElement(view.KanbusBoardPanelView, { snapshot: requireController().getSnapshot(), handlers: { onRefresh: () => undefined } }),
  );
  return { html, text: textOfMarkup(html), elements: testElementsOfMarkup(html) };
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
      controller ??= new KanbusBoardController({ api: computerFilesApiFor({ tenantId: "anthus", userId: "ryan" }), now: () => fake.nowMs });
      controller.setActive(true);
      await settle();
      return null;
    }
    case "refresh":
      await requireController().refresh();
      await settle();
      return null;
    case "forget-requests":
      fake.requests.length = 0;
      return null;
    case "state": {
      const rendered = await render();
      return { ...rendered, requests: fake.requests.map((request) => ({ method: request.method, route: request.route, query: request.query })) };
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
