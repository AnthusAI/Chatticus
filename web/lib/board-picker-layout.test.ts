import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boardPickerLayoutFor } from "./board-picker-layout";

describe("boardPickerLayoutFor", () => {
  const cases = [
    ["a panel that fills a desktop window", 1360, "side"],
    ["a panel that fills an iPad held sideways", 880, "side"],
    ["the narrowest panel with room for both", 720, "side"],
    ["a panel one point too narrow", 719, "sheet"],
    ["a panel docked beside the conversation on an iPad held sideways", 400, "sheet"],
    ["a panel on a phone", 390, "sheet"],
    ["a panel not measured yet", 0, "sheet"],
  ] as const;
  for (const [name, width, expected] of cases) {
    it(`uses the ${expected} layout for ${name}`, () => {
      assert.equal(boardPickerLayoutFor(width), expected);
    });
  }
});
