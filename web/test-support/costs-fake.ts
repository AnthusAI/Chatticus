import {
  channelCostResponseSchema,
  costErrorBodySchema,
  costRowsResponseSchema,
  costSummaryResponseSchema,
  costTotalsSchema,
  turnCostResponseSchema,
  COST_EXPORT_TURN_COLUMNS,
  type CostCall,
  type CostGroup,
  type CostRow,
  type CostTotals,
} from "../../host-protocol/src/costs.ts";

export type FakeCall = { model: string; costUsd: string | null };

export type FakeTurn = {
  name: string;
  bot: string | null;
  channel: string | null;
  month: string;
  calls: FakeCall[];
  status: string;
  source: "session" | "gateway" | "estimated";
  promptSeq: number | null;
  replySeq: number | null;
};

export type RecordedCostRequest = {
  method: string;
  route: string;
  query: Record<string, string>;
  headers: Record<string, string>;
};

const SCALE = 12;
const PRICE_BOOK_ID = "openai@2026-10-11";
const TODAY = "2026-10-12";
const OPEN_STATUSES = new Set(["running", "yielded", "parked"]);
const ROWS_DEFAULT = 50;
const ROWS_MAX = 200;
const GROUPS_DEFAULT = 100;

function toScaled(text: string): bigint {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(`${whole}${fraction.padEnd(SCALE, "0").slice(0, SCALE)}`);
}

function fromScaled(value: bigint): string {
  const digits = value.toString().padStart(SCALE + 1, "0");
  const whole = digits.slice(0, digits.length - SCALE);
  const fraction = digits.slice(digits.length - SCALE).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function slug(prefix: string, name: string): string {
  return `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function recordedAt(turn: FakeTurn, index: number): string {
  const minute = String(index % 60).padStart(2, "0");
  const hour = String(8 + Math.floor(index / 60)).padStart(2, "0");
  const day = turn.month === "2026-10" ? "05" : "15";
  return `${turn.month}-${day}T${hour}:${minute}:00.000Z`;
}

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  if (!match) throw new FakeCostFailure(400, "invalid_query", "That cursor was not issued by this route.");
  return Number(match[1]);
}

function cursorFor(offset: number): string {
  return Buffer.from(`offset:${offset}`).toString("base64url");
}

class FakeCostFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A fake cost API behind the member cost routes. It answers with the JSON shapes of host-protocol/src/costs.ts and
 * validates every body it sends against those schemas. Totals are worked out from the seeded model calls with the
 * rule of the real read model: a model with an unpriced call in a turn has no dollar subtotal in that turn.
 */
export class FakeCostApi {
  turns: FakeTurn[] = [];
  isMember = true;
  failNext = false;
  unreadableSessions = new Set<string>();
  requests: RecordedCostRequest[] = [];
  private lastExport: { format: string | null; grain: string | null } = { format: null, grain: null };

  seed(turns: FakeTurn[]): void {
    this.turns = turns;
  }

  seedBulk(count: number, costUsd: string): void {
    this.turns = Array.from({ length: count }, (_unused, index) => ({
      name: `bulk-${String(index + 1).padStart(3, "0")}`,
      bot: "Pi",
      channel: "Planning",
      month: "2026-10",
      calls: [{ model: "gpt-5.4-mini", costUsd }],
      status: "completed",
      source: "session" as const,
      promptSeq: null,
      replySeq: null,
    }));
  }

  get exportRequest(): { format: string | null; grain: string | null } {
    return this.lastExport;
  }

  botName(botId: string): string | null {
    const found = this.turns.find((turn) => turn.bot !== null && slug("bot", turn.bot) === botId);
    return found?.bot ?? null;
  }

  channelName(channelId: string): string | null {
    const found = this.turns.find((turn) => turn.channel !== null && slug("channel", turn.channel) === channelId);
    return found?.channel ?? null;
  }

  channelIdOf(name: string): string {
    return slug("channel", name);
  }

  private totalsOf(turns: readonly FakeTurn[]): CostTotals {
    let calls = 0;
    let pricedScaled = 0n;
    let unpriced = 0;
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    const byModel = new Map<string, { calls: number; scaled: bigint; unpriced: number }>();
    for (const turn of turns) {
      const turnModels = new Map<string, { scaled: bigint; unpriced: number; calls: number }>();
      for (const call of turn.calls) {
        calls += 1;
        input += 1200;
        cacheRead += 800;
        cacheWrite += 100;
        output += 300;
        const entry = turnModels.get(call.model) ?? { scaled: 0n, unpriced: 0, calls: 0 };
        entry.calls += 1;
        if (call.costUsd === null) entry.unpriced += 1;
        else entry.scaled += toScaled(call.costUsd);
        turnModels.set(call.model, entry);
      }
      for (const [model, entry] of turnModels) {
        const counted = entry.unpriced === 0 ? entry.scaled : 0n;
        pricedScaled += counted;
        unpriced += entry.unpriced;
        const total = byModel.get(model) ?? { calls: 0, scaled: 0n, unpriced: 0 };
        total.calls += entry.calls;
        total.scaled += counted;
        total.unpriced += entry.unpriced;
        byModel.set(model, total);
      }
    }
    const priced = fromScaled(pricedScaled);
    const complete = unpriced === 0;
    return costTotalsSchema.parse({
      rows: turns.length,
      turns: turns.filter((turn) => turn.source === "session").length,
      calls,
      input_tokens: input,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      output_tokens: output,
      priced_cost_usd: priced,
      cost_usd: complete ? priced : null,
      unpriced_calls: unpriced,
      complete,
      gateway_rows: turns.filter((turn) => turn.source !== "session").length,
      estimated_rows: turns.filter((turn) => turn.source === "estimated").length,
      open_turns: turns.filter((turn) => OPEN_STATUSES.has(turn.status)).length,
      price_book_ids: turns.length === 0 ? [] : [PRICE_BOOK_ID],
      by_model: [...byModel.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([model, entry]) => ({
          model,
          calls: entry.calls,
          input_tokens: entry.calls * 1200,
          cache_read_tokens: entry.calls * 800,
          cache_write_tokens: entry.calls * 100,
          output_tokens: entry.calls * 300,
          priced_cost_usd: fromScaled(entry.scaled),
          unpriced_calls: entry.unpriced,
        })),
    });
  }

  private rowOf(turn: FakeTurn, index: number): CostRow {
    const isSession = turn.source === "session";
    return {
      id: turn.name,
      row_kind: isSession ? "turn" : "gateway_call",
      turn_id: isSession ? turn.name : null,
      bot_id: turn.bot === null ? null : slug("bot", turn.bot),
      channel_id: turn.channel === null ? null : slug("channel", turn.channel),
      member_id: isSession ? "member-ryan" : null,
      prompt_message_seq: turn.promptSeq,
      message_seq: turn.replySeq,
      owner_kind: isSession ? "lambda" : null,
      status: turn.status,
      source: isSession ? "session" : "gateway",
      estimated: turn.source === "estimated",
      recorded_at: recordedAt(turn, index),
      updated_at: null,
      totals: this.totalsOf([turn]),
    };
  }

  private windowOf(query: Record<string, string>, defaultToLookback: boolean): { from: string; to: string } {
    const to = query.to ?? TODAY;
    const from = query.from ?? (defaultToLookback ? "2023-11-01" : `${to.slice(0, 7)}-01`);
    return { from, to };
  }

  private selected(
    query: Record<string, string>,
    defaultToLookback: boolean,
  ): { turns: Array<{ turn: FakeTurn; index: number }>; from: string; to: string } {
    const { from, to } = this.windowOf(query, defaultToLookback);
    const turns = this.turns
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn, index }) => {
        const day = recordedAt(turn, index).slice(0, 10);
        if (day < from || day > to) return false;
        if (query.channel_id && (turn.channel === null || slug("channel", turn.channel) !== query.channel_id)) return false;
        if (query.bot_id && (turn.bot === null || slug("bot", turn.bot) !== query.bot_id)) return false;
        return true;
      });
    return { turns, from, to };
  }

  private newestFirst(turns: Array<{ turn: FakeTurn; index: number }>): Array<{ turn: FakeTurn; index: number }> {
    return [...turns].sort((left, right) =>
      recordedAt(right.turn, right.index).localeCompare(recordedAt(left.turn, left.index)) || right.index - left.index,
    );
  }

  private page<T>(items: T[], query: Record<string, string>, fallbackLimit: number): { items: T[]; next: string | null } {
    const limit = Math.min(Number(query.limit ?? fallbackLimit), query.limit ? ROWS_MAX : Infinity);
    const offset = offsetOf(query.cursor);
    const slice = items.slice(offset, offset + limit);
    return { items: slice, next: offset + limit < items.length ? cursorFor(offset + limit) : null };
  }

  private groups(
    turns: Array<{ turn: FakeTurn; index: number }>,
    dimension: "bot" | "channel",
  ): CostGroup[] {
    const keyed = new Map<string | null, FakeTurn[]>();
    for (const { turn } of turns) {
      const name = dimension === "bot" ? turn.bot : turn.channel;
      const key = name === null ? null : slug(dimension, name);
      keyed.set(key, [...(keyed.get(key) ?? []), turn]);
    }
    return [...keyed.entries()]
      .sort(([left], [right]) => (left === null ? 1 : right === null ? -1 : left.localeCompare(right)))
      .map(([key, members]) => ({ key, totals: this.totalsOf(members) }));
  }

  private respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": typeof body === "string" ? "text/csv; charset=utf-8" : "application/json", ...headers },
    });
  }

  private failure(error: FakeCostFailure): Response {
    return this.respond(error.status, costErrorBodySchema.parse({ error: error.code, message: error.message }));
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://costs.test");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const route = url.pathname.replace(/^.*\/orgs\/[^/]+/, "");
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ method: init?.method ?? "GET", route, query, headers });
    if (!this.isMember || !headers.authorization?.startsWith("Bearer ")) {
      return this.respond(403, { detail: "Not an enabled member of this organization." });
    }
    if (this.failNext) {
      this.failNext = false;
      return this.respond(500, { error: "internal", message: "Something broke." });
    }
    try {
      return this.route(route, query);
    } catch (error) {
      if (error instanceof FakeCostFailure) return this.failure(error);
      throw error;
    }
  };

  private route(route: string, query: Record<string, string>): Response {
    if (route === "/costs") return this.summaryRoute(query);
    if (route === "/costs/turns") return this.turnsRoute(query);
    if (route === "/costs/export") return this.exportRoute(query);
    const channelMatch = /^\/channels\/([^/]+)\/cost$/.exec(route);
    if (channelMatch) return this.channelRoute(decodeURIComponent(channelMatch[1]), query);
    const turnMatch = /^\/turns\/([^/]+)\/cost$/.exec(route);
    if (turnMatch) return this.turnRoute(decodeURIComponent(turnMatch[1]));
    return this.respond(404, { error: "channel_not_found", message: "No such route." });
  }

  private summaryRoute(query: Record<string, string>): Response {
    const { turns, from, to } = this.selected(query, false);
    if (query.group_by !== undefined && query.group_by !== "bot" && query.group_by !== "channel") {
      throw new FakeCostFailure(400, "invalid_query", "This fake groups only by bot or channel.");
    }
    const groups = query.group_by ? this.groups(turns, query.group_by as "bot" | "channel") : [];
    const page = this.page(groups, query, GROUPS_DEFAULT);
    return this.respond(
      200,
      costSummaryResponseSchema.parse({
        tenant_id: "anthus",
        from,
        to,
        group_by: query.group_by ?? null,
        filters: { bot_id: null, channel_id: null, member_id: null },
        totals: this.totalsOf(turns.map(({ turn }) => turn)),
        groups: page.items,
        next_cursor: page.next,
      }),
    );
  }

  private turnsRoute(query: Record<string, string>): Response {
    const { turns, from, to } = this.selected(query, false);
    const ordered = this.newestFirst(turns);
    const page = this.page(ordered, query, ROWS_DEFAULT);
    return this.respond(
      200,
      costRowsResponseSchema.parse({
        tenant_id: "anthus",
        from,
        to,
        filters: { bot_id: null, channel_id: null, member_id: null },
        totals: this.totalsOf(turns.map(({ turn }) => turn)),
        rows: page.items.map(({ turn, index }) => this.rowOf(turn, index)),
        next_cursor: page.next,
      }),
    );
  }

  private channelRoute(channelId: string, query: Record<string, string>): Response {
    const { turns, from, to } = this.selected({ ...query, channel_id: channelId }, true);
    const ordered = this.newestFirst(turns);
    const page = this.page(ordered, query, ROWS_DEFAULT);
    return this.respond(
      200,
      channelCostResponseSchema.parse({
        tenant_id: "anthus",
        channel_id: channelId,
        from,
        to,
        totals: this.totalsOf(turns.map(({ turn }) => turn)),
        by_bot: this.groups(turns, "bot"),
        rows: page.items.map(({ turn, index }) => this.rowOf(turn, index)),
        next_cursor: page.next,
      }),
    );
  }

  private callsOf(turn: FakeTurn, index: number): CostCall[] {
    return turn.calls.map((call, position) => ({
      conversation_id: "conversation-root",
      entry_id: position + 1,
      kind: "turn_round" as const,
      round: position + 1,
      provider: "openai",
      model: call.model,
      response_id: `resp-${turn.name}-${position + 1}`,
      input_tokens: 1200,
      cache_read_tokens: 800,
      cache_write_tokens: 100,
      output_tokens: 300,
      reasoning_tokens: 0,
      context_tokens: 2100,
      price_book_id: PRICE_BOOK_ID,
      tier: call.costUsd === null ? null : ("standard" as const),
      priced_with: call.costUsd === null ? [] : ["input", "cache_read", "cache_write", "output"],
      input_rate_per_million_usd: call.costUsd === null ? null : "0.25",
      output_rate_per_million_usd: call.costUsd === null ? null : "2",
      cost_usd: call.costUsd,
      unpriced: call.costUsd === null,
      recorded_at: recordedAt(turn, index),
    }));
  }

  private turnRoute(turnId: string): Response {
    const found = this.turns.map((turn, index) => ({ turn, index })).find(({ turn }) => turn.name === turnId && turn.source === "session");
    if (!found) throw new FakeCostFailure(404, "turn_not_found", `No turn ${turnId} in this organization.`);
    const readable = !this.unreadableSessions.has(turnId);
    return this.respond(
      200,
      turnCostResponseSchema.parse({
        tenant_id: "anthus",
        turn_id: turnId,
        channel_id: found.turn.channel === null ? "channel-none" : slug("channel", found.turn.channel),
        bot_id: found.turn.bot === null ? "bot-none" : slug("bot", found.turn.bot),
        row: this.rowOf(found.turn, found.index),
        totals: this.totalsOf([found.turn]),
        calls: readable ? this.callsOf(found.turn, found.index) : [],
        calls_available: readable,
      }),
    );
  }

  private exportRoute(query: Record<string, string>): Response {
    this.lastExport = { format: query.format ?? null, grain: query.grain ?? null };
    const { turns, from, to } = this.selected(query, false);
    const lines = [COST_EXPORT_TURN_COLUMNS.join(",")];
    for (const { turn, index } of this.newestFirst(turns)) {
      lines.push([turn.name, this.rowOf(turn, index).totals.priced_cost_usd].join(","));
    }
    return this.respond(200, `${lines.join("\n")}\n`, {
      "Content-Disposition": `attachment; filename="costs-${from}-${to}-${query.grain}.${query.format}"`,
    });
  }
}
