import { createInterface } from "node:readline";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setIdTokenSourceForTests } from "../lib/api-auth";
import { costsApiFor } from "../lib/costs-api";
import { CostsController } from "../lib/costs-controller";
import { replyLatenciesBySeq, type MessageMoment } from "../lib/costs";
import { FakeCostApi, type FakeCall, type FakeTurn } from "./costs-fake";

(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-12T10:00:00.000Z");
const PREVIEW_MESSAGE_COUNT = 6;

const fake = new FakeCostApi();
let controller: CostsController | null = null;
let messageMoments: MessageMoment[] = [];
let delivered: Array<{ filename: string; mimeType: string; text: string }> = [];

globalThis.fetch = fake.fetch as typeof fetch;
setIdTokenSourceForTests(async () => "harness-token");

async function settle(): Promise<void> {
  for (let round = 0; round < 25; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function requireController(): CostsController {
  if (controller === null) throw new Error("the cost view has not been started");
  return controller;
}

function startController(): CostsController {
  if (controller === null) {
    controller = new CostsController({
      api: costsApiFor({ tenantId: "anthus", userId: "ryan" }),
      now: () => NOW,
      deliverFile: (file) => {
        delivered.push(file);
      },
    });
  }
  return controller;
}

function parseCalls(text: string, defaultModel: string): FakeCall[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const separator = item.indexOf(":");
      const model = separator < 0 ? defaultModel : item.slice(0, separator);
      const cost = separator < 0 ? item : item.slice(separator + 1);
      return { model, costUsd: cost === "unpriced" ? null : cost };
    });
}

type SeedRow = Record<string, string>;

const FIRST_MESSAGE_WRITTEN_AT_MS = NOW.getTime() - 60 * 60 * 1000;
const MILLISECONDS_BETWEEN_PROMPTS = 60 * 1000;

function seedMessageMoments(rows: SeedRow[]): MessageMoment[] {
  return rows.flatMap((row) => {
    if (!row.prompt || !row.reply || !row.replied_after_seconds) return [];
    const promptSeq = Number(row.prompt);
    const promptWrittenAtMs = FIRST_MESSAGE_WRITTEN_AT_MS + promptSeq * MILLISECONDS_BETWEEN_PROMPTS;
    const replyWrittenAtMs = promptWrittenAtMs + Number(row.replied_after_seconds) * 1000;
    return [
      { seq: promptSeq, created_at: new Date(promptWrittenAtMs).toISOString() },
      { seq: Number(row.reply), created_at: new Date(replyWrittenAtMs).toISOString() },
    ];
  });
}

function seedTurns(rows: SeedRow[]): FakeTurn[] {
  return rows.map((row) => ({
    name: row.turn,
    bot: row.bot ? row.bot : null,
    channel: row.channel ? row.channel : null,
    month: row.month ? row.month : "2026-10",
    calls: parseCalls(row.calls, row.model),
    status: row.status ? row.status : "completed",
    source: (row.source ? row.source : "session") as FakeTurn["source"],
    promptSeq: row.prompt ? Number(row.prompt) : null,
    replySeq: row.reply ? Number(row.reply) : null,
  }));
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

type TestElement = { testId: string; text: string; label: string | null };

function testElementsOf(html: string): TestElement[] {
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  const stack: Array<{ tag: string; start: number; testId: string | null; label: string | null }> = [];
  const found: TestElement[] = [];
  for (let match = tagPattern.exec(html); match !== null; match = tagPattern.exec(html)) {
    const [whole, closing, tag, attributes, selfClosing] = match;
    if (closing === "/") {
      const open = stack.pop();
      if (open && open.testId !== null) {
        found.push({ testId: open.testId, text: textOf(html.slice(open.start, match.index)), label: open.label });
      }
      continue;
    }
    if (selfClosing === "/") continue;
    const testId = /data-testid="([^"]*)"/.exec(attributes)?.[1] ?? null;
    const label = /data-label="([^"]*)"/.exec(attributes)?.[1] ?? null;
    stack.push({ tag, start: match.index + whole.length, testId, label });
  }
  return found;
}

async function render(): Promise<{ html: string; text: string; elements: TestElement[] }> {
  const view = await import("../components/workspace/CostsPanelView");
  const markers = await import("../components/workspace/CostMarkers");
  const current = requireController();
  const snapshot = current.getSnapshot();
  const noop = () => undefined;
  const labels = {
    botName: (botId: string) => fake.botName(botId) ?? botId,
    channelName: (channelId: string) => fake.channelName(channelId) ?? channelId,
  };
  const panel = createElement(view.CostsPanelView, {
    snapshot,
    labels,
    handlers: {
      onSetScope: noop,
      onPreviousMonth: noop,
      onNextMonth: noop,
      onRetry: noop,
      onLoadMoreTurns: noop,
      onLoadMoreGroups: noop,
      onOpenTurn: noop,
      onCloseDrilldown: noop,
      onCloseMessageFocus: noop,
      onExport: noop,
    },
  });
  const channelRows = snapshot.channel.status === "ready" ? snapshot.channel.value.turns.rows : [];
  const replyLatencyMsBySeq = replyLatenciesBySeq(channelRows, messageMoments);
  const slots = Array.from({ length: PREVIEW_MESSAGE_COUNT }, (_unused, index) =>
    createElement("div", { key: index, "data-testid": `message-${index + 1}` }, createElement(markers.MessageCostSlot, { seq: index + 1 })),
  );
  const preview = createElement(
    "div",
    { "data-testid": "conversation-preview" },
    createElement(markers.ChannelCostChip, { phase: snapshot.channel, replyLatenciesMs: [...replyLatencyMsBySeq.values()], onOpen: noop }),
    createElement(
      markers.MessageCostContext.Provider,
      { value: { markers: snapshot.markers, replyLatencyMsBySeq, onOpen: noop } },
      createElement("div", null, slots),
    ),
  );
  const panelHtml = renderToStaticMarkup(panel);
  const previewHtml = renderToStaticMarkup(preview);
  const html = `${previewHtml}${panelHtml}`;
  return { html, text: textOf(panelHtml), elements: testElementsOf(html) };
}

type Command = { op: string } & Record<string, any>;

const CONTROLLER_METHODS = new Set([
  "previousMonth",
  "nextMonth",
  "retry",
  "loadMoreTurns",
  "loadMoreGroups",
  "openTurn",
  "closeDrilldown",
  "openMessage",
  "closeMessageFocus",
  "exportCosts",
  "setScope",
]);

async function handle(command: Command): Promise<unknown> {
  switch (command.op) {
    case "init": {
      fake.isMember = command.member;
      if (command.bulk) fake.seedBulk(command.bulk.count, command.bulk.cost);
      else fake.seed(seedTurns(command.rows ?? []));
      messageMoments = seedMessageMoments(command.rows ?? []);
      return null;
    }
    case "open-tab": {
      const started = startController();
      started.setActive(true);
      await settle();
      return null;
    }
    case "select-channel": {
      const started = startController();
      await started.selectChannel(fake.channelIdOf(command.name));
      await settle();
      return null;
    }
    case "call": {
      if (!CONTROLLER_METHODS.has(command.method)) throw new Error(`unknown controller method ${command.method}`);
      await (requireController() as any)[command.method](...(command.args ?? []));
      await settle();
      return null;
    }
    case "fake": {
      const method = command.method as string;
      if (method === "failNext") fake.failNext = true;
      else if (method === "unreadable") fake.unreadableSessions.add(command.args[0]);
      else throw new Error(`unknown fake method ${method}`);
      return null;
    }
    case "state": {
      const rendered = await render();
      const snapshot = requireController().getSnapshot();
      return {
        html: rendered.html,
        text: rendered.text,
        elements: rendered.elements,
        requests: fake.requests,
        exportRequest: fake.exportRequest,
        delivered,
        organizationStatus: snapshot.organization.status,
        channelStatus: snapshot.channel.status,
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
