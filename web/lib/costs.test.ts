import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CostGroup, CostRow, CostTotals } from "@chatticus/host-protocol/costs";

import {
  addDecimalTexts,
  breakdownLines,
  buildMessageMarkers,
  replyLatenciesBySeq,
  replyLatencyText,
  sessionLatencyText,
  typicalReplyLatencyMs,
  describeFigure,
  describeTotalsNotes,
  formatRecordedAt,
  formatUsd,
  markerText,
  modelLines,
  monthDayRange,
  monthIsReadable,
  monthLabel,
  nextMonthKey,
  pluralize,
  previousMonthKey,
  roundDecimalText,
  rowBadges,
} from "./costs";

function totals(overrides: Partial<CostTotals> = {}): CostTotals {
  return {
    rows: 1,
    turns: 1,
    calls: 1,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    priced_cost_usd: "0.0003",
    cost_usd: "0.0003",
    unpriced_calls: 0,
    complete: true,
    gateway_rows: 0,
    estimated_rows: 0,
    open_turns: 0,
    price_book_ids: ["openai@2026-10-11"],
    by_model: [],
    ...overrides,
  };
}

function row(overrides: Partial<CostRow> & { totals?: CostTotals } = {}): CostRow {
  return {
    id: "r1",
    row_kind: "turn",
    turn_id: "t1",
    bot_id: "bot-pi",
    channel_id: "channel-planning",
    member_id: "member-ryan",
    prompt_message_seq: null,
    message_seq: null,
    owner_kind: "lambda",
    status: "completed",
    source: "session",
    estimated: false,
    recorded_at: "2026-10-05T09:00:00.000Z",
    updated_at: null,
    totals: totals(),
    ...overrides,
  };
}

describe("formatUsd for a call", () => {
  it("keeps the exact cents-of-a-cent", () => {
    assert.equal(formatUsd("0.0001852", "call"), "$0.0001852");
    assert.equal(formatUsd("0.0000185", "call"), "$0.0000185");
  });

  it("drops trailing zeros down to four places", () => {
    assert.equal(formatUsd("0.5", "call"), "$0.5000");
    assert.equal(formatUsd("0.0125", "call"), "$0.0125");
    assert.equal(formatUsd("2", "call"), "$2.0000");
  });

  it("rounds beyond seven places half up and never to zero", () => {
    assert.equal(formatUsd("0.00018524", "call"), "$0.0001852");
    assert.equal(formatUsd("0.00018525", "call"), "$0.0001853");
    assert.equal(formatUsd("0.00000004", "call"), "less than $0.0000001");
  });
});

describe("formatUsd for a total", () => {
  it("rounds to cents from one dollar up, with thousands separators", () => {
    assert.equal(formatUsd("1", "total"), "$1.00");
    assert.equal(formatUsd("12.3456", "total"), "$12.35");
    assert.equal(formatUsd("1234567.891", "total"), "$1,234,567.89");
  });

  it("uses four places between a hundredth of a cent and a dollar", () => {
    assert.equal(formatUsd("0.0133852", "total"), "$0.0134");
    assert.equal(formatUsd("0.5002", "total"), "$0.5002");
    assert.equal(formatUsd("0.0001", "total"), "$0.0001");
  });

  it("shows three significant digits below a hundredth of a cent so sub-cent spend is visible", () => {
    assert.equal(formatUsd("0.0000185", "total"), "$0.0000185");
    assert.equal(formatUsd("0.00001849", "total"), "$0.0000185");
    assert.equal(formatUsd("0.0000000123", "total"), "less than $0.0000001");
  });

  it("does not print a rounded-up dollar with four places", () => {
    assert.equal(formatUsd("0.99996", "total"), "$1.00");
  });

  it("writes only an exact zero as zero", () => {
    assert.equal(formatUsd("0", "total"), "$0.00");
    assert.equal(formatUsd("0.000000", "total"), "$0.00");
  });

  it("is the default precision", () => {
    assert.equal(formatUsd("0.0133852"), "$0.0134");
  });
});

describe("decimal arithmetic", () => {
  it("adds decimal texts exactly", () => {
    assert.equal(addDecimalTexts(["0.1", "0.2"]), "0.3");
    assert.equal(addDecimalTexts(["0.0001852", "0.0007"]), "0.0008852");
    assert.equal(addDecimalTexts([]), "0");
  });

  it("rounds half up to a fixed number of places", () => {
    assert.equal(roundDecimalText("0.12345", 4), "0.1235");
    assert.equal(roundDecimalText("9.9999", 2), "10.00");
    assert.equal(roundDecimalText("5", 0), "5");
  });
});

describe("describeFigure", () => {
  it("writes a whole total as a plain amount", () => {
    const figure = describeFigure(totals({ cost_usd: "0.0134", priced_cost_usd: "0.0134" }));
    assert.deepEqual(figure, { text: "$0.0134", complete: true, incompleteLabel: null });
  });

  it("says at least and incomplete when a call has no price", () => {
    const figure = describeFigure(totals({ complete: false, cost_usd: null, unpriced_calls: 2, priced_cost_usd: "0.0005" }));
    assert.equal(figure.text, "at least $0.0005");
    assert.equal(figure.complete, false);
    assert.equal(figure.incompleteLabel, "incomplete: 2 unpriced calls");
  });

  it("counts one unpriced call in the singular", () => {
    const figure = describeFigure(totals({ complete: false, cost_usd: null, unpriced_calls: 1 }));
    assert.equal(figure.incompleteLabel, "incomplete: 1 unpriced call");
  });

  it("never trusts a complete flag when the total is null", () => {
    const figure = describeFigure(totals({ complete: true, cost_usd: null, unpriced_calls: 0 }));
    assert.equal(figure.complete, false);
    assert.equal(figure.incompleteLabel, "incomplete: the total is not known");
  });

  it("never trusts a total the API calls incomplete", () => {
    const figure = describeFigure(totals({ complete: false, cost_usd: "0.0003", unpriced_calls: 1 }));
    assert.equal(figure.complete, false);
    assert.match(figure.text, /^at least /);
  });
});

describe("totals notes and badges", () => {
  it("names unfinished turns, estimated rows, gateway rows and mixed price books", () => {
    const notes = describeTotalsNotes(
      totals({ open_turns: 2, estimated_rows: 1, gateway_rows: 3, price_book_ids: ["a", "b"] }),
    );
    assert.deepEqual(notes, [
      "2 turns are still running, so the total may grow.",
      "1 estimated row: the gateway estimated an interrupted call.",
      "3 rows seen only by the model gateway.",
      "Priced with more than one price book: a, b.",
    ]);
  });

  it("is quiet for a plain total", () => {
    assert.deepEqual(describeTotalsNotes(totals()), []);
  });

  it("labels estimated, gateway, voice and unfinished rows", () => {
    assert.deepEqual(rowBadges(row({ estimated: true, source: "gateway", row_kind: "gateway_call" })), ["estimated", "gateway"]);
    assert.deepEqual(rowBadges(row({ status: "running" })), ["running"]);
    assert.deepEqual(rowBadges(row({ row_kind: "voice_understanding" })), ["voice"]);
    assert.deepEqual(rowBadges(row()), []);
  });
});

describe("months", () => {
  it("walks months across a year boundary", () => {
    assert.equal(previousMonthKey("2026-01"), "2025-12");
    assert.equal(nextMonthKey("2025-12"), "2026-01");
  });

  it("names a month and its days", () => {
    assert.equal(monthLabel("2026-10"), "October 2026");
    assert.deepEqual(monthDayRange("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(monthDayRange("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  });

  it("reads only the lookback and never the future", () => {
    assert.equal(monthIsReadable("2026-10", "2026-10"), true);
    assert.equal(monthIsReadable("2026-11", "2026-10"), false);
    assert.equal(monthIsReadable("2023-11", "2026-10"), true);
    assert.equal(monthIsReadable("2023-10", "2026-10"), false);
  });

  it("writes a recorded time in UTC", () => {
    assert.equal(formatRecordedAt("2026-10-05T09:07:00.000Z"), "5 Oct 09:07 UTC");
    assert.equal(formatRecordedAt("not a date"), "");
  });
});

describe("breakdown lines", () => {
  const groups: CostGroup[] = [
    { key: "bot-pi", totals: totals({ priced_cost_usd: "0.0009", cost_usd: "0.0009" }) },
    { key: null, totals: totals({ priced_cost_usd: "9", cost_usd: "9" }) },
    { key: "bot-ada", totals: totals({ priced_cost_usd: "0.0125", cost_usd: "0.0125" }) },
  ];

  it("orders by spend, puts the group without a key last, and names the keys", () => {
    const lines = breakdownLines(groups, "bot", (key) => key.replace("bot-", "").toUpperCase());
    assert.deepEqual(lines.map((line) => line.label), ["ADA", "PI", "Not tied to a bot"]);
    assert.equal(lines[0].figure.text, "$0.0125");
  });

  it("carries an incomplete group's label", () => {
    const lines = breakdownLines(
      [{ key: "bot-pi", totals: totals({ complete: false, cost_usd: null, unpriced_calls: 1 }) }],
      "bot",
      (key) => key,
    );
    assert.equal(lines[0].figure.incompleteLabel, "incomplete: 1 unpriced call");
  });

  it("builds model lines from the by-model counters", () => {
    const lines = modelLines(
      totals({
        by_model: [
          { model: "cheap", calls: 2, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, priced_cost_usd: "0.001", unpriced_calls: 0 },
          { model: "dear", calls: 1, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, priced_cost_usd: "0.5", unpriced_calls: 1 },
        ],
      }),
    );
    assert.deepEqual(lines.map((line) => line.label), ["dear", "cheap"]);
    assert.equal(lines[0].figure.text, "at least $0.5000");
    assert.equal(lines[1].figure.text, "$0.0010");
  });
});

describe("message markers", () => {
  it("prices the prompt a turn answered and the reply it wrote", () => {
    const markers = buildMessageMarkers([
      row({ prompt_message_seq: 1, message_seq: 2, totals: totals({ priced_cost_usd: "0.0002", cost_usd: "0.0002" }) }),
    ]);
    assert.equal(markerText(markers.get(1)![0]), "Triggered $0.0002");
    assert.equal(markerText(markers.get(2)![0]), "Took $0.0002");
    assert.equal(markers.get(3), undefined);
  });

  it("adds the turns a message triggered and lists them once", () => {
    const markers = buildMessageMarkers([
      row({ id: "a", turn_id: "ta", prompt_message_seq: 1, message_seq: 2, totals: totals({ priced_cost_usd: "0.0002", cost_usd: "0.0002" }) }),
      row({ id: "b", turn_id: "tb", prompt_message_seq: 1, message_seq: 3, totals: totals({ priced_cost_usd: "0.001", cost_usd: "0.001" }) }),
    ]);
    const triggered = markers.get(1)![0];
    assert.equal(markerText(triggered), "Triggered $0.0012");
    assert.deepEqual(triggered.turnIds, ["ta", "tb"]);
  });

  it("is incomplete when any of its rows is", () => {
    const markers = buildMessageMarkers([
      row({ message_seq: 2, totals: totals({ complete: false, cost_usd: null, unpriced_calls: 1, priced_cost_usd: "0.0002" }) }),
    ]);
    assert.equal(markerText(markers.get(2)![0]), "Took at least $0.0002");
    assert.equal(markers.get(2)![0].figure.incompleteLabel, "incomplete: 1 unpriced call");
  });
});

describe("reply latency", () => {
  const moments = [
    { seq: 1, created_at: "2026-10-12T09:00:00.000Z" },
    { seq: 2, created_at: "2026-10-12T09:00:04.200Z" },
    { seq: 3, created_at: "2026-10-12T09:01:00.000Z" },
    { seq: 4, created_at: "2026-10-12T09:00:59.000Z" },
  ];

  it("measures from the prompt a turn answered to the reply it wrote", () => {
    const latencies = replyLatenciesBySeq([row({ prompt_message_seq: 1, message_seq: 2 })], moments);
    assert.equal(latencies.get(2), 4200);
  });

  it("leaves out a turn with a missing message, an unknown message or a reply written before its prompt", () => {
    const latencies = replyLatenciesBySeq(
      [
        row({ id: "a", prompt_message_seq: 1, message_seq: null }),
        row({ id: "b", prompt_message_seq: 1, message_seq: 9 }),
        row({ id: "c", prompt_message_seq: 3, message_seq: 4 }),
      ],
      moments,
    );
    assert.equal(latencies.size, 0);
  });

  it("takes the median, averaging the middle two", () => {
    assert.equal(typicalReplyLatencyMs([]), null);
    assert.equal(typicalReplyLatencyMs([9000, 1000, 5000]), 5000);
    assert.equal(typicalReplyLatencyMs([1000, 3000, 5000, 9000]), 4000);
  });

  it("writes the times people read", () => {
    assert.equal(replyLatencyText(340), "replied in 340 ms");
    assert.equal(replyLatencyText(4200), "replied in 4.2 s");
    assert.equal(sessionLatencyText([2000, 8000, 14000]), "typical reply 8.0 s");
    assert.equal(sessionLatencyText([]), null);
  });
});

describe("pluralize", () => {
  it("counts with thousands separators", () => {
    assert.equal(pluralize(1, "turn"), "1 turn");
    assert.equal(pluralize(1200, "model call"), "1,200 model calls");
  });
});
