import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTime } from "./time";

describe("formatTime", () => {
  it("formats an ISO date string", () => {
    const formatted = formatTime("2026-01-01T12:00:00.000Z");
    assert.match(formatted, /^\d{1,2}:\d{2}\s?(?:AM|PM)?$/i);
  });

  it("formats a Date instance", () => {
    const formatted = formatTime(new Date("2026-01-01T12:00:00.000Z"));
    assert.match(formatted, /^\d{1,2}:\d{2}\s?(?:AM|PM)?$/i);
  });

  it("returns empty string when value is undefined or null", () => {
    assert.equal(formatTime(undefined), "");
    assert.equal(formatTime(null), "");
    assert.equal(formatTime(""), "");
  });

  it("returns empty string when date value is invalid", () => {
    assert.equal(formatTime("invalid-date-string"), "");
    assert.equal(formatTime(new Date("invalid")), "");
  });
});
