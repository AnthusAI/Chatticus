import { createInterface } from "node:readline";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setIdTokenSourceForTests } from "../lib/api-auth";
import { computerFilesApiFor } from "../lib/computer-files-api";
import { ComputerFilesController, type Scheduler } from "../lib/computer-files-controller";
import { describePendingChange } from "../lib/computer-files-overlay";
import { collectTouchedFiles, type TouchedFile } from "../lib/touched-files";
import type { ToolCardModel } from "../lib/turn-activity";
import { FakeComputerFiles, type FakeMode } from "./computer-files-fake";

(globalThis as { React?: typeof React }).React = React;

const START_MS = Date.parse("2026-10-12T10:00:00.000Z");

type Timer = { id: number; due: number; callback: () => void };

class FakeScheduler implements Scheduler {
  nowMs = START_MS;
  timers: Timer[] = [];
  private nextId = 1;

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const timer = { id: this.nextId++, due: this.nowMs + delayMs, callback };
    this.timers.push(timer);
    return timer.id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  now = (): number => this.nowMs;

  dueIn(): number[] {
    return this.timers.map((timer) => timer.due - this.nowMs).sort((left, right) => left - right);
  }

  async advance(ms: number, afterEach: () => Promise<void>): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.due <= target).sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.nowMs = next.due;
      next.callback();
      await afterEach();
    }
    this.nowMs = target;
  }
}

const fake = new FakeComputerFiles();
const scheduler = new FakeScheduler();
let controller: ComputerFilesController | null = null;
let touched: TouchedFile[] = [];
let copiedText: string | null = null;

globalThis.fetch = fake.fetch as typeof fetch;
setIdTokenSourceForTests(async () => "harness-token");

async function settle(): Promise<void> {
  for (let round = 0; round < 25; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function requireController(): ComputerFilesController {
  if (controller === null) throw new Error("the Files tab has not been opened");
  return controller;
}

function openTab(): ComputerFilesController {
  if (controller === null) {
    fake.nowMs = scheduler.nowMs;
    controller = new ComputerFilesController({
      api: computerFilesApiFor({ tenantId: "anthus", userId: "ryan" }),
      scheduler,
      role: fake.role,
    });
    controller.start();
    controller.setActive(true);
    controller.noteTouched([]);
  }
  return controller;
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function renderPanel(): Promise<{ html: string; text: string }> {
  const view = await import("../components/workspace/ComputerFilesPanelView");
  const current = requireController();
  const noop = () => undefined;
  const html = renderToStaticMarkup(
    createElement(view.ComputerFilesPanelView, {
      snapshot: current.getSnapshot(),
      touched,
      copied: copiedText !== null,
      handlers: {
        onRefresh: noop,
        onOpenDirectory: noop,
        onOpenFile: noop,
        onBack: noop,
        onLoadMore: noop,
        onCopy: noop,
        onEdit: noop,
        onDraft: noop,
        onSave: noop,
        onRetrySave: noop,
        onReloadUnknown: noop,
        onShowTheirs: noop,
        onOverwrite: noop,
        onUseTheirs: noop,
        onCopyMine: noop,
        onRequestReveal: noop,
        onHide: noop,
        onAnswer: noop,
        onNewFile: noop,
        onNewFolder: noop,
        onRename: noop,
        onDelete: noop,
        onOpenPending: noop,
        onClosePending: noop,
        onDiscardPending: noop,
      },
    }),
  );
  return { html, text: textOf(html) };
}

function toolCard(tool: string, path: string, status: ToolCardModel["status"]): ToolCardModel {
  return {
    callId: `call-${scheduler.nowMs}-${tool}`,
    tool,
    label: tool,
    kind: "generic",
    summary: null,
    status,
    durationMs: null,
    arguments: { path },
    argumentsTruncated: false,
    output: null,
    outputTruncated: false,
    openByDefault: false,
  };
}

type Command = { op: string } & Record<string, any>;

const CONTROLLER_METHODS = new Set([
  "refresh",
  "openFile",
  "openDirectory",
  "backToFolder",
  "beginEdit",
  "setDraft",
  "save",
  "retrySave",
  "reloadAfterUnknown",
  "showTheirVersion",
  "overwriteWithMine",
  "useTheirs",
  "requestReveal",
  "hide",
  "createFile",
  "requestDelete",
  "renameEntry",
  "makeFolder",
  "setPendingOpen",
  "requestDiscardPending",
  "loadMore",
  "setActive",
]);

async function handle(command: Command): Promise<unknown> {
  switch (command.op) {
    case "init": {
      fake.role = command.role;
      fake.userEmail = command.email;
      fake.setMode(command.mode as FakeMode);
      return null;
    }
    case "open-tab": {
      openTab();
      await settle();
      return null;
    }
    case "call": {
      const target = openTab();
      if (!CONTROLLER_METHODS.has(command.method)) throw new Error(`unknown controller method ${command.method}`);
      await (target as any)[command.method](...(command.args ?? []));
      await settle();
      return null;
    }
    case "answer": {
      await requireController().answerConfirm(command.confirmed);
      await settle();
      return null;
    }
    case "advance": {
      await scheduler.advance(command.ms, settle);
      fake.nowMs = scheduler.nowMs;
      await settle();
      return null;
    }
    case "tool-card": {
      const card = toolCard(command.tool, command.path, command.status ?? "ok");
      touched = collectTouchedFiles([card]);
      requireController().noteTouched(touched);
      await settle();
      return null;
    }
    case "fake": {
      const method = command.method as keyof FakeComputerFiles;
      const member = (fake as any)[method];
      if (typeof member === "function") return member.apply(fake, command.args ?? []);
      if (command.args && command.args.length === 1) {
        (fake as any)[method] = command.args[0];
        return null;
      }
      return member;
    }
    case "fake-state": {
      return {
        mode: fake.mode,
        otherRequests: fake.otherRequests,
        requests: fake.requests,
        audit: fake.audit,
        live: Object.fromEntries([...fake.live].map(([path, node]) => [path, node.content])),
        listingNames: fake.listingNames(command.directory ?? "/workspace"),
        exists: command.path ? fake.exists(command.path) : null,
        overlayCount: fake.overlay.length,
      };
    }
    case "state": {
      const snapshot = requireController().getSnapshot();
      const rendered = await renderPanel();
      const listing = snapshot.listing.status === "ready" ? snapshot.listing.listing.entries.map((entry) => entry.name) : [];
      return {
        snapshot: {
          sourceText: snapshot.source.text,
          directory: snapshot.directory,
          openFile: snapshot.openFile,
          marks: snapshot.marks,
          edit: snapshot.edit,
          conflict: snapshot.conflict,
          confirm: snapshot.confirm,
          status: snapshot.status,
          pendingDescriptions: snapshot.pending.entries.map(describePendingChange),
          pendingPaths: snapshot.pending.entries.map((entry) => entry.path),
          pendingOpen: snapshot.pending.open,
          listingNames: listing,
          changesOffered: snapshot.changesOffered,
        },
        html: rendered.html,
        text: rendered.text,
        timersDueIn: scheduler.dueIn(),
        nowMs: scheduler.nowMs,
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
