import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ICON_ONLY_CONTROL_NAMES,
  orderedMessages,
  regionsOpenedAsSheets,
} from "./workspace-actions";
import { resolveRosterViewState } from "./workspace-state";
import type { Message } from "./api";

const messageAt = (seq: number) => ({ seq }) as Message;

describe("workspace actions", () => {
  it("orders messages by sequence without mutating the input", () => {
    const input = [messageAt(3), messageAt(1), messageAt(2)];
    assert.deepEqual(orderedMessages(input).map((message) => message.seq), [1, 2, 3]);
    assert.deepEqual(input.map((message) => message.seq), [3, 1, 2]);
  });

  it("opens both regions as sheets only below their desktop widths", () => {
    assert.equal(regionsOpenedAsSheets(375).length, 2);
    assert.equal(regionsOpenedAsSheets(1000).length, 1);
    assert.equal(regionsOpenedAsSheets(1440).length, 0);
  });

  it("separates a search with no match from an empty roster", () => {
    const base = { loading: false, failed: false, rosterRowCount: 0, visibleRowCount: 0 };
    assert.equal(resolveRosterViewState({ ...base, query: "" }), "empty");
    assert.equal(resolveRosterViewState({ ...base, query: "zzz" }), "no-match");
  });

  it("names every icon-only button in the workspace component from the shared names", () => {
    const source = readFileSync(join(__dirname, "..", "components", "EnabledWorkspace.tsx"), "utf8");
    const iconButtons = source.match(/<Button[^>]*size="icon"[^>]*>/g) ?? [];
    assert.ok(iconButtons.length >= 4);
    for (const button of iconButtons) {
      assert.match(button, /aria-label=\{ICON_ONLY_CONTROL_NAMES\.\w+\}/);
    }
    assert.equal(Object.keys(ICON_ONLY_CONTROL_NAMES).length, 5);
  });
});
