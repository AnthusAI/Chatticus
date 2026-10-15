/**
 * The pure parts of the cost view: how dollars are written, how a total says whether it is whole, how months and
 * message markers are worked out. No React, no network. The wire shapes are the zod schemas of
 * `@chatticus/host-protocol/costs`; only their types are imported here.
 */

import type { CostGroup, CostRow, CostTotals } from "@chatticus/host-protocol/costs";

/** The words that say what the numbers are. They are the same everywhere a figure appears. */
export const COST_BASIS_COPY = "Model token cost at published list prices. This is not a bill.";

/** The smallest amount the view writes out; anything smaller shows as "less than" this. */
export const SMALLEST_SHOWN_USD = "0.0000001";

const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const FRACTION_PLACES_MAX = 7;
const CALL_FRACTION_PLACES_MIN = 4;
const TOTAL_FRACTION_PLACES_SMALL = 4;
const TOTAL_SIGNIFICANT_DIGITS_TINY = 3;

type DecimalParts = { negative: boolean; whole: string; fraction: string };

function splitDecimal(text: string): DecimalParts {
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  return { negative, whole: whole === "" ? "0" : whole, fraction };
}

function isZeroParts(parts: DecimalParts): boolean {
  return /^0*$/.test(parts.whole) && /^0*$/.test(parts.fraction);
}

/** The magnitude of a plain decimal text rounded half up to `places` fraction digits, as fixed-places text. */
export function roundDecimalText(text: string, places: number): string {
  const { whole, fraction } = splitDecimal(text);
  const kept = fraction.slice(0, places).padEnd(places, "0");
  const roundsUp = fraction.length > places && fraction.charCodeAt(places) >= "5".charCodeAt(0);
  const scaled = BigInt(`${whole}${kept}`) + (roundsUp ? BIG_ONE : BIG_ZERO);
  if (places === 0) return scaled.toString();
  const digits = scaled.toString().padStart(places + 1, "0");
  return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
}

function withThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function trimFraction(fixed: string, minimumPlaces: number): string {
  const [whole, fraction = ""] = fixed.split(".");
  let end = fraction.length;
  while (end > minimumPlaces && fraction[end - 1] === "0") end -= 1;
  return end === 0 ? whole : `${whole}.${fraction.slice(0, end)}`;
}

function firstNonZeroFractionPlace(fraction: string): number {
  const index = fraction.search(/[1-9]/);
  return index < 0 ? 0 : index + 1;
}

function underSmallest(parts: DecimalParts): boolean {
  return parts.whole.replace(/^0+/, "") === "" && roundDecimalText(`0.${parts.fraction}`, FRACTION_PLACES_MAX) === "0.0000000";
}

/** How exact a dollar figure is written: a call or turn shows its exact cents-of-a-cent, a total is rounded sensibly. */
export type MoneyPrecision = "call" | "total";

/**
 * Writes a plain decimal dollar text for a person.
 *
 * A call or turn figure (`call`) is exact to seven decimal places, with trailing zeros dropped down to four places:
 * 0.0001852 reads `$0.0001852`, 0.5 reads `$0.5000`.
 * A total figure (`total`) is rounded to cents from one dollar up, to four places from a hundredth of a cent up to
 * one dollar, and to three significant digits (at most seven places) below that, so any spend that exists is visible.
 * Only an exact zero reads `$0.00`; a nonzero amount under a ten-millionth of a dollar reads `less than $0.0000001`.
 */
export function formatUsd(decimalText: string, precision: MoneyPrecision = "total"): string {
  const parts = splitDecimal(decimalText);
  const sign = parts.negative ? "-" : "";
  if (isZeroParts(parts)) return "$0.00";
  if (underSmallest(parts)) return `less than ${sign}$${SMALLEST_SHOWN_USD}`;
  const magnitude = `${parts.whole}.${parts.fraction}`;
  if (precision === "call") {
    const fixed = roundDecimalText(magnitude, FRACTION_PLACES_MAX);
    const [whole, fraction] = fixed.split(".");
    return `${sign}$${trimFraction(`${withThousands(whole)}.${fraction}`, CALL_FRACTION_PLACES_MIN)}`;
  }
  const wholeDigits = parts.whole.replace(/^0+/, "");
  if (wholeDigits !== "") {
    const [whole, cents] = roundDecimalText(magnitude, 2).split(".");
    return `${sign}$${withThousands(whole)}.${cents}`;
  }
  const hundredthOfCentOrMore = firstNonZeroFractionPlace(parts.fraction) <= TOTAL_FRACTION_PLACES_SMALL;
  const places = hundredthOfCentOrMore
    ? TOTAL_FRACTION_PLACES_SMALL
    : Math.min(FRACTION_PLACES_MAX, firstNonZeroFractionPlace(parts.fraction) + TOTAL_SIGNIFICANT_DIGITS_TINY - 1);
  const rounded = roundDecimalText(magnitude, places);
  if (rounded.startsWith("1")) {
    const [whole, cents] = roundDecimalText(magnitude, 2).split(".");
    return `${sign}$${withThousands(whole)}.${cents}`;
  }
  return `${sign}$${rounded}`;
}

const SCALE_PLACES = 12;

function decimalToScaled(text: string): bigint {
  const parts = splitDecimal(text);
  const scaled = BigInt(`${parts.whole}${parts.fraction.slice(0, SCALE_PLACES).padEnd(SCALE_PLACES, "0")}`);
  return parts.negative ? -scaled : scaled;
}

function scaledToDecimal(value: bigint): string {
  const negative = value < BIG_ZERO;
  const digits = (negative ? -value : value).toString().padStart(SCALE_PLACES + 1, "0");
  const whole = digits.slice(0, digits.length - SCALE_PLACES);
  const fraction = digits.slice(digits.length - SCALE_PLACES).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction === "" ? whole : `${whole}.${fraction}`}`;
}

/** The exact sum of plain decimal dollar texts, as plain decimal text with no trailing zeros. */
export function addDecimalTexts(values: readonly string[]): string {
  return scaledToDecimal(values.reduce((sum, value) => sum + decimalToScaled(value), BIG_ZERO));
}

/** Whole numbers with thousands separators. */
export function formatCount(value: number): string {
  return withThousands(String(Math.round(value)));
}

/** "1 turn", "2 turns". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

/** One dollar figure and what must be said beside it so it is not mistaken for a whole total. */
export type CostFigure = {
  /** The text of the amount: `$0.0134`, or `at least $0.0003` when a call has no price. */
  text: string;
  complete: boolean;
  /** `incomplete: 1 unpriced call` when the figure leaves something out, otherwise null. */
  incompleteLabel: string | null;
};

type FigureSource = Pick<CostTotals, "complete" | "cost_usd" | "priced_cost_usd" | "unpriced_calls">;

/**
 * The figure for a set of rows. A total the API calls whole is written as a plain amount; any other is written as
 * `at least` the priced dollars and carries an `incomplete` label. The API's `complete` flag and a null `cost_usd`
 * both mean the total is not known.
 */
export function describeFigure(totals: FigureSource, precision: MoneyPrecision = "total"): CostFigure {
  if (totals.complete && totals.cost_usd !== null) {
    return { text: formatUsd(totals.cost_usd, precision), complete: true, incompleteLabel: null };
  }
  const label =
    totals.unpriced_calls > 0
      ? `incomplete: ${pluralize(totals.unpriced_calls, "unpriced call")}`
      : "incomplete: the total is not known";
  return { text: `at least ${formatUsd(totals.priced_cost_usd, precision)}`, complete: false, incompleteLabel: label };
}

/** The honest notes under a total: unfinished turns, estimated rows, rows only the gateway saw, mixed price books. */
export function describeTotalsNotes(totals: CostTotals): string[] {
  const notes: string[] = [];
  if (totals.open_turns > 0) {
    notes.push(
      totals.open_turns === 1
        ? "1 turn is still running, so the total may grow."
        : `${formatCount(totals.open_turns)} turns are still running, so the total may grow.`,
    );
  }
  if (totals.estimated_rows > 0) {
    notes.push(`${pluralize(totals.estimated_rows, "estimated row")}: the gateway estimated an interrupted call.`);
  }
  if (totals.gateway_rows > 0) {
    notes.push(`${pluralize(totals.gateway_rows, "row")} seen only by the model gateway.`);
  }
  if (totals.price_book_ids.length > 1) {
    notes.push(`Priced with more than one price book: ${totals.price_book_ids.join(", ")}.`);
  }
  return notes;
}

/** The small labels on a row: `estimated`, `gateway`, `voice`, and its status while it is not finished. */
export function rowBadges(row: Pick<CostRow, "estimated" | "source" | "row_kind" | "status">): string[] {
  const badges: string[] = [];
  if (row.estimated) badges.push("estimated");
  if (row.source === "gateway") badges.push("gateway");
  if (row.row_kind === "voice_understanding") badges.push("voice");
  if (row.status === "running" || row.status === "yielded" || row.status === "parked") badges.push(row.status);
  else if (row.status === "failed") badges.push("failed");
  return badges;
}

/** Writes a count of tokens. */
export function formatTokens(value: number): string {
  return formatCount(value);
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** How many calendar months back the cost routes read, counting the current one. */
export const COST_LOOKBACK_MONTHS_SHOWN = 36;

/** `5 Oct 09:00 UTC`: when a row was recorded, in UTC so the same instant reads the same everywhere. */
export function formatRecordedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()].slice(0, 3)} ${hours}:${minutes} UTC`;
}

/** The month of a date as `yyyy-mm` in UTC, the way the API files it. */
export function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);
}

function monthFromIndex(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** `October 2026`. */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** The month before, as `yyyy-mm`. */
export function previousMonthKey(month: string): string {
  return monthFromIndex(monthIndex(month) - 1);
}

/** The month after, as `yyyy-mm`. */
export function nextMonthKey(month: string): string {
  return monthFromIndex(monthIndex(month) + 1);
}

/** True while a month is inside the months the cost routes read and no later than the current one. */
export function monthIsReadable(month: string, current: string): boolean {
  const index = monthIndex(month);
  return index <= monthIndex(current) && index > monthIndex(current) - COST_LOOKBACK_MONTHS_SHOWN;
}

/** The first and last day of a month as `yyyy-mm-dd`. */
export function monthDayRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const lastDay = new Date(Date.UTC(year, Number(month.slice(5, 7)), 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** What a breakdown groups on. */
export type BreakdownKind = "bot" | "channel" | "model";

/** One line of a breakdown, with its name worked out and the figure and counts the API gave. */
export type BreakdownLine = {
  key: string | null;
  label: string;
  figure: CostFigure;
  pricedCostUsd: string;
  turns: number;
  calls: number;
};

/** The words for a group that carries no value for its dimension. */
export function missingKeyLabel(kind: BreakdownKind): string {
  return kind === "bot" ? "Not tied to a bot" : kind === "channel" ? "Not tied to a conversation" : "Unknown model";
}

function comparePricedDescending(left: string, right: string): number {
  const difference = decimalToScaled(right) - decimalToScaled(left);
  return difference > BIG_ZERO ? 1 : difference < BIG_ZERO ? -1 : 0;
}

/** Breakdown lines, the most spent first and the group with no key last. */
export function breakdownLines(
  groups: readonly CostGroup[],
  kind: BreakdownKind,
  nameOf: (key: string) => string,
): BreakdownLine[] {
  return groups
    .map((group) => ({
      key: group.key,
      label: group.key === null ? missingKeyLabel(kind) : nameOf(group.key),
      figure: describeFigure(group.totals),
      pricedCostUsd: group.totals.priced_cost_usd,
      turns: group.totals.turns,
      calls: group.totals.calls,
    }))
    .sort((left, right) => {
      if ((left.key === null) !== (right.key === null)) return left.key === null ? 1 : -1;
      return comparePricedDescending(left.pricedCostUsd, right.pricedCostUsd) || left.label.localeCompare(right.label);
    });
}

/** The by-model lines of a totals object, most spent first. */
export function modelLines(totals: CostTotals): BreakdownLine[] {
  return totals.by_model
    .map((entry) => ({
      key: entry.model,
      label: entry.model,
      figure: describeFigure({
        complete: entry.unpriced_calls === 0,
        cost_usd: entry.unpriced_calls === 0 ? entry.priced_cost_usd : null,
        priced_cost_usd: entry.priced_cost_usd,
        unpriced_calls: entry.unpriced_calls,
      }),
      pricedCostUsd: entry.priced_cost_usd,
      turns: 0,
      calls: entry.calls,
    }))
    .sort((left, right) => comparePricedDescending(left.pricedCostUsd, right.pricedCostUsd) || left.label.localeCompare(right.label));
}

/** What a message in the thread cost: what it set off (`triggered`) or what it took to write (`produced`). */
export type MessageCostMarker = {
  seq: number;
  side: "triggered" | "produced";
  verb: "Triggered" | "Took";
  figure: CostFigure;
  turnIds: string[];
};

type MarkerBucket = { rows: CostRow[]; turnIds: string[] };

function figureOfRows(rows: readonly CostRow[]): CostFigure {
  const priced = addDecimalTexts(rows.map((row) => row.totals.priced_cost_usd));
  const unpriced = rows.reduce((sum, row) => sum + row.totals.unpriced_calls, 0);
  const complete = rows.every((row) => row.totals.complete && row.totals.cost_usd !== null);
  return describeFigure(
    { complete, cost_usd: complete ? priced : null, priced_cost_usd: priced, unpriced_calls: unpriced },
    "call",
  );
}

/**
 * The markers for the messages of one conversation, worked out from the rows of its cost: a row prices the message
 * that prompted it (`prompt_message_seq`) and the message it wrote (`message_seq`). A message with no row has no marker.
 */
export function buildMessageMarkers(rows: readonly CostRow[]): Map<number, MessageCostMarker[]> {
  const buckets = new Map<string, MarkerBucket>();
  const add = (seq: number, side: "triggered" | "produced", row: CostRow) => {
    const key = `${seq}:${side}`;
    const bucket = buckets.get(key) ?? { rows: [], turnIds: [] };
    bucket.rows.push(row);
    if (row.turn_id !== null && !bucket.turnIds.includes(row.turn_id)) bucket.turnIds.push(row.turn_id);
    buckets.set(key, bucket);
  };
  for (const row of rows) {
    if (row.prompt_message_seq !== null) add(row.prompt_message_seq, "triggered", row);
    if (row.message_seq !== null) add(row.message_seq, "produced", row);
  }
  const markers = new Map<number, MessageCostMarker[]>();
  for (const [key, bucket] of buckets) {
    const [seqText, side] = key.split(":");
    const seq = Number(seqText);
    const marker: MessageCostMarker = {
      seq,
      side: side as "triggered" | "produced",
      verb: side === "triggered" ? "Triggered" : "Took",
      figure: figureOfRows(bucket.rows),
      turnIds: bucket.turnIds,
    };
    markers.set(seq, [...(markers.get(seq) ?? []), marker]);
  }
  return markers;
}

/** The text a marker shows: `Took $0.0002`, `Took at least $0.0002`. */
export function markerText(marker: MessageCostMarker): string {
  return `${marker.verb} ${marker.figure.text}`;
}
