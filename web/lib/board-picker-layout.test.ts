import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boardPickerLayoutFor } from "./board-picker-layout";

describe("boardPickerLayoutFor", () => {
  const cases = [
    ["a desktop", 1440, 900, "side"],
    ["an iPad held sideways", 1180, 820, "side"],
    ["the smallest iPad held sideways", 1024, 768, "side"],
    ["an iPad held upright", 820, 1180, "sheet"],
    ["the largest iPad held upright", 1024, 1366, "sheet"],
    ["a phone", 390, 844, "sheet"],
    ["a phone held sideways", 844, 390, "sheet"],
    ["a narrow window", 900, 700, "sheet"],
  ] as const;
  for (const [name, width, height, expected] of cases) {
    it(`uses the ${expected} layout on ${name}`, () => {
      assert.equal(boardPickerLayoutFor(width, height), expected);
    });
  }
});
