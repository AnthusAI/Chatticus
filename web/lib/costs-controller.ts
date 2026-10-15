/**
 * The behavior of the cost view, with no React and no DOM: which month is open, what the organization and the open
 * conversation cost, the turns a page at a time, the per-turn call list, the markers of the messages, and the CSV
 * download. The React views render a snapshot and forward clicks; the behavior scenarios drive the same object
 * against a fake cost API. Every read goes through the injected api.
 */

import type {
  CostGroup,
  CostRow,
  CostTotals,
  TurnCostResponse,
} from "@chatticus/host-protocol/costs";

import { CostsApiError, type CostsApi, type CostsDownload, type CostsExportGrain, type CostsQuery } from "./costs-api";
import {
  buildMessageMarkers,
  monthDayRange,
  monthIsReadable,
  monthKeyOf,
  nextMonthKey,
  previousMonthKey,
  type MessageCostMarker,
} from "./costs";

/** What the cost view says when a read failed, and whether trying again can help. */
export type CostsErrorView = { text: string; retryable: boolean; refused: boolean };

export const COSTS_REFUSED_TEXT = "Only members of this organization can see its costs.";
export const COSTS_FAILED_TEXT = "Could not load the costs. Try again.";

/** Turns an error from a cost route into the words the view shows. */
export function describeCostsError(error: unknown): CostsErrorView {
  if (error instanceof CostsApiError) {
    if (error.status === 401 || error.status === 403) return { text: COSTS_REFUSED_TEXT, retryable: false, refused: true };
    if (error.status >= 400 && error.status < 500 && error.code !== null) {
      return { text: error.message, retryable: false, refused: false };
    }
  }
  return { text: COSTS_FAILED_TEXT, retryable: true, refused: false };
}

export type Phase<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: CostsErrorView }
  | { status: "ready"; value: T };

/** One page of groups of a rollup, and the cursor of the next. */
export type GroupPage = { groups: CostGroup[]; next: string | null; loadingMore: boolean };

/** The turns of a range or a conversation, a page at a time. */
export type TurnsPage = { rows: CostRow[]; next: string | null; loadingMore: boolean; moreFailed: boolean };

/** The organization's cost for the open month. */
export type OrganizationCosts = {
  from: string;
  to: string;
  totals: CostTotals;
  bots: GroupPage;
  channels: GroupPage;
  turns: TurnsPage;
};

/** The cost of the open conversation. */
export type ChannelCosts = {
  channelId: string;
  from: string;
  to: string;
  totals: CostTotals;
  bots: CostGroup[];
  turns: TurnsPage;
};

export type DrilldownPhase =
  | { status: "loading"; turnId: string }
  | { status: "error"; turnId: string; error: CostsErrorView }
  | { status: "ready"; turnId: string; detail: TurnCostResponse };

/** Several turns behind one message, listed so one can be opened. */
export type MessageFocus = { seq: number; rows: CostRow[] };

export type ExportPhase =
  | { status: "idle" }
  | { status: "working"; grain: CostsExportGrain }
  | { status: "done"; filename: string }
  | { status: "error"; error: CostsErrorView };

export type CostScope = "organization" | "channel";

export type CostsSnapshot = {
  active: boolean;
  scope: CostScope;
  channelId: string | null;
  month: string;
  currentMonth: string;
  canGoToPreviousMonth: boolean;
  canGoToNextMonth: boolean;
  organization: Phase<OrganizationCosts>;
  channel: Phase<ChannelCosts>;
  drilldown: DrilldownPhase | null;
  messageFocus: MessageFocus | null;
  exportPhase: ExportPhase;
  markers: ReadonlyMap<number, MessageCostMarker[]>;
};

export type CostsControllerOptions = {
  api: CostsApi;
  now: () => Date;
  deliverFile: (file: CostsDownload) => void;
};

const CHANNEL_ROWS_PER_PAGE = 200;

function emptyTurnsPage(rows: CostRow[], next: string | null): TurnsPage {
  return { rows, next, loadingMore: false, moreFailed: false };
}

/** The behavior of the cost view; see the file comment. */
export class CostsController {
  private snapshot: CostsSnapshot;
  private readonly listeners = new Set<() => void>();
  private organizationSequence = 0;
  private channelSequence = 0;
  private drilldownSequence = 0;
  private organizationRequested = false;

  constructor(private readonly options: CostsControllerOptions) {
    const currentMonth = monthKeyOf(options.now());
    this.snapshot = {
      active: false,
      scope: "organization",
      channelId: null,
      month: currentMonth,
      currentMonth,
      canGoToPreviousMonth: monthIsReadable(previousMonthKey(currentMonth), currentMonth),
      canGoToNextMonth: false,
      organization: { status: "idle" },
      channel: { status: "idle" },
      drilldown: null,
      messageFocus: null,
      exportPhase: { status: "idle" },
      markers: new Map(),
    };
  }

  getSnapshot = (): CostsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<CostsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Whether the Costs tab is the one showing; the organization's cost is read the first time it is. */
  setActive(active: boolean): void {
    if (active === this.snapshot.active) return;
    this.update({ active });
    if (active && !this.organizationRequested) void this.loadOrganization();
  }

  /** The conversation whose cost the header chip and the message markers show; null when none is open. */
  selectChannel(channelId: string | null): Promise<void> {
    if (channelId === this.snapshot.channelId) return Promise.resolve();
    this.channelSequence += 1;
    this.update({
      channelId,
      scope: channelId === null ? "organization" : this.snapshot.scope,
      channel: { status: "idle" },
      markers: new Map(),
      messageFocus: null,
      drilldown: null,
    });
    return channelId === null ? Promise.resolve() : this.loadChannel(channelId);
  }

  /** Reads the open conversation's cost again, for example after a turn ended. */
  refreshChannel(): Promise<void> {
    const channelId = this.snapshot.channelId;
    return channelId === null ? Promise.resolve() : this.loadChannel(channelId, { quiet: true });
  }

  setScope(scope: CostScope): void {
    if (scope === "channel" && this.snapshot.channelId === null) return;
    this.update({ scope, messageFocus: null, drilldown: null });
  }

  previousMonth(): Promise<void> {
    return this.moveToMonth(previousMonthKey(this.snapshot.month));
  }

  nextMonth(): Promise<void> {
    return this.moveToMonth(nextMonthKey(this.snapshot.month));
  }

  private moveToMonth(month: string): Promise<void> {
    const { currentMonth } = this.snapshot;
    if (!monthIsReadable(month, currentMonth)) return Promise.resolve();
    this.update({
      month,
      canGoToPreviousMonth: monthIsReadable(previousMonthKey(month), currentMonth),
      canGoToNextMonth: monthIsReadable(nextMonthKey(month), currentMonth),
      messageFocus: null,
      drilldown: null,
    });
    return this.loadOrganization();
  }

  /** Reads again what failed. */
  retry(): Promise<void> {
    if (this.snapshot.scope === "channel" && this.snapshot.channelId !== null) return this.loadChannel(this.snapshot.channelId);
    return this.loadOrganization();
  }

  private rangeQuery(): CostsQuery {
    const { month, currentMonth } = this.snapshot;
    return month === currentMonth ? {} : monthDayRange(month);
  }

  private async loadOrganization(): Promise<void> {
    this.organizationRequested = true;
    const sequence = ++this.organizationSequence;
    this.update({ organization: { status: "loading" } });
    const range = this.rangeQuery();
    try {
      const [bots, channels, turns] = await Promise.all([
        this.options.api.summary({ ...range, groupBy: "bot" }),
        this.options.api.summary({ ...range, groupBy: "channel" }),
        this.options.api.turns(range),
      ]);
      if (sequence !== this.organizationSequence) return;
      this.update({
        organization: {
          status: "ready",
          value: {
            from: bots.from,
            to: bots.to,
            totals: bots.totals,
            bots: { groups: bots.groups, next: bots.next_cursor, loadingMore: false },
            channels: { groups: channels.groups, next: channels.next_cursor, loadingMore: false },
            turns: emptyTurnsPage(turns.rows, turns.next_cursor),
          },
        },
      });
    } catch (error) {
      if (sequence !== this.organizationSequence) return;
      this.update({ organization: { status: "error", error: describeCostsError(error) } });
    }
  }

  private async loadChannel(channelId: string, options: { quiet?: boolean } = {}): Promise<void> {
    const sequence = ++this.channelSequence;
    if (!options.quiet || this.snapshot.channel.status !== "ready") this.update({ channel: { status: "loading" } });
    try {
      const response = await this.options.api.channelCost(channelId, { limit: CHANNEL_ROWS_PER_PAGE });
      if (sequence !== this.channelSequence) return;
      const turns = emptyTurnsPage(response.rows, response.next_cursor);
      this.update({
        channel: {
          status: "ready",
          value: {
            channelId,
            from: response.from,
            to: response.to,
            totals: response.totals,
            bots: response.by_bot,
            turns,
          },
        },
        markers: buildMessageMarkers(response.rows),
      });
    } catch (error) {
      if (sequence !== this.channelSequence) return;
      this.update({ channel: { status: "error", error: describeCostsError(error) }, markers: new Map() });
    }
  }

  /** Reads the next page of the turns shown. */
  async loadMoreTurns(): Promise<void> {
    if (this.snapshot.scope === "channel") return this.loadMoreChannelTurns();
    const current = this.snapshot.organization;
    if (current.status !== "ready" || current.value.turns.next === null || current.value.turns.loadingMore) return;
    const sequence = this.organizationSequence;
    const cursor = current.value.turns.next;
    this.setOrganizationTurns({ ...current.value.turns, loadingMore: true, moreFailed: false });
    try {
      const page = await this.options.api.turns({ ...this.rangeQuery(), cursor });
      if (sequence !== this.organizationSequence) return;
      const latest = this.snapshot.organization;
      if (latest.status !== "ready") return;
      this.setOrganizationTurns(emptyTurnsPage([...latest.value.turns.rows, ...page.rows], page.next_cursor));
    } catch {
      if (sequence !== this.organizationSequence) return;
      const latest = this.snapshot.organization;
      if (latest.status !== "ready") return;
      this.setOrganizationTurns({ ...latest.value.turns, loadingMore: false, moreFailed: true });
    }
  }

  private setOrganizationTurns(turns: TurnsPage): void {
    const current = this.snapshot.organization;
    if (current.status !== "ready") return;
    this.update({ organization: { status: "ready", value: { ...current.value, turns } } });
  }

  private async loadMoreChannelTurns(): Promise<void> {
    const current = this.snapshot.channel;
    if (current.status !== "ready" || current.value.turns.next === null || current.value.turns.loadingMore) return;
    const sequence = this.channelSequence;
    const { channelId } = current.value;
    const cursor = current.value.turns.next;
    this.setChannelTurns({ ...current.value.turns, loadingMore: true, moreFailed: false });
    try {
      const page = await this.options.api.channelCost(channelId, { limit: CHANNEL_ROWS_PER_PAGE, cursor });
      if (sequence !== this.channelSequence) return;
      const latest = this.snapshot.channel;
      if (latest.status !== "ready") return;
      const rows = [...latest.value.turns.rows, ...page.rows];
      this.setChannelTurns(emptyTurnsPage(rows, page.next_cursor));
      this.update({ markers: buildMessageMarkers(rows) });
    } catch {
      if (sequence !== this.channelSequence) return;
      const latest = this.snapshot.channel;
      if (latest.status !== "ready") return;
      this.setChannelTurns({ ...latest.value.turns, loadingMore: false, moreFailed: true });
    }
  }

  private setChannelTurns(turns: TurnsPage): void {
    const current = this.snapshot.channel;
    if (current.status !== "ready") return;
    this.update({ channel: { status: "ready", value: { ...current.value, turns } } });
  }

  /** Reads the next page of the bot or conversation groups. */
  async loadMoreGroups(kind: "bot" | "channel"): Promise<void> {
    const current = this.snapshot.organization;
    if (current.status !== "ready") return;
    const page = kind === "bot" ? current.value.bots : current.value.channels;
    if (page.next === null || page.loadingMore) return;
    const sequence = this.organizationSequence;
    const replace = (next: GroupPage): void => {
      const latest = this.snapshot.organization;
      if (latest.status !== "ready") return;
      this.update({
        organization: { status: "ready", value: { ...latest.value, [kind === "bot" ? "bots" : "channels"]: next } },
      });
    };
    replace({ ...page, loadingMore: true });
    try {
      const response = await this.options.api.summary({ ...this.rangeQuery(), groupBy: kind, cursor: page.next });
      if (sequence !== this.organizationSequence) return;
      replace({ groups: [...page.groups, ...response.groups], next: response.next_cursor, loadingMore: false });
    } catch {
      if (sequence !== this.organizationSequence) return;
      replace({ ...page, loadingMore: false });
    }
  }

  /** Opens the call list of one turn. */
  async openTurn(turnId: string): Promise<void> {
    const sequence = ++this.drilldownSequence;
    this.update({ drilldown: { status: "loading", turnId } });
    try {
      const detail = await this.options.api.turnCost(turnId);
      if (sequence !== this.drilldownSequence) return;
      this.update({ drilldown: { status: "ready", turnId, detail } });
    } catch (error) {
      if (sequence !== this.drilldownSequence) return;
      this.update({ drilldown: { status: "error", turnId, error: describeCostsError(error) } });
    }
  }

  /** Closes the call list, back to the turns (or to the turns of the message it was opened from). */
  closeDrilldown(): void {
    this.drilldownSequence += 1;
    this.update({ drilldown: null });
  }

  /** Opens what a message cost: the call list of its turn, or a list when several turns are behind it. */
  async openMessage(seq: number): Promise<void> {
    const markers = this.snapshot.markers.get(seq);
    const channel = this.snapshot.channel;
    if (!markers || channel.status !== "ready") return;
    const turnIds = [...new Set(markers.flatMap((marker) => marker.turnIds))];
    if (turnIds.length === 1) {
      this.update({ messageFocus: null });
      await this.openTurn(turnIds[0]);
      return;
    }
    const rows = channel.value.turns.rows.filter((row) => row.turn_id !== null && turnIds.includes(row.turn_id));
    this.update({ messageFocus: { seq, rows }, drilldown: null });
  }

  /** Closes the list of turns behind a message. */
  closeMessageFocus(): void {
    this.update({ messageFocus: null });
  }

  /** Downloads the shown range as CSV, one row per turn or per model call. */
  async exportCosts(grain: CostsExportGrain): Promise<void> {
    const query = this.exportQuery();
    if (query === null) return;
    this.update({ exportPhase: { status: "working", grain } });
    try {
      const file = await this.options.api.exportCosts(query, grain);
      this.options.deliverFile(file);
      this.update({ exportPhase: { status: "done", filename: file.filename } });
    } catch (error) {
      this.update({ exportPhase: { status: "error", error: describeCostsError(error) } });
    }
  }

  private exportQuery(): CostsQuery | null {
    const { scope, organization, channel } = this.snapshot;
    if (scope === "channel") {
      return channel.status === "ready"
        ? { from: channel.value.from, to: channel.value.to, channelId: channel.value.channelId }
        : null;
    }
    return organization.status === "ready" ? { from: organization.value.from, to: organization.value.to } : null;
  }
}
