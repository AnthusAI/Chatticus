import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reportHeroWordmarkVisibility, subscribeToHeroWordmarkVisibility } from "./wordmark-presence";

describe("wordmark-presence", () => {
  it("calls a new subscriber immediately with the current value", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToHeroWordmarkVisibility((visible) => seen.push(visible));
    assert.deepEqual(seen, [false]);
    unsubscribe();
  });

  it("notifies subscribers only when the value actually changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToHeroWordmarkVisibility((visible) => seen.push(visible));
    reportHeroWordmarkVisibility(true);
    reportHeroWordmarkVisibility(true); // no-op, same value
    reportHeroWordmarkVisibility(false);
    unsubscribe();
    assert.deepEqual(seen, [false, true, false]);
  });

  it("stops notifying after unsubscribe", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToHeroWordmarkVisibility((visible) => seen.push(visible));
    unsubscribe();
    reportHeroWordmarkVisibility(true);
    assert.deepEqual(seen, [false]);
    reportHeroWordmarkVisibility(false); // reset for other tests sharing the module singleton
  });

  it("supports multiple independent subscribers", () => {
    const seenA: boolean[] = [];
    const seenB: boolean[] = [];
    const unsubA = subscribeToHeroWordmarkVisibility((v) => seenA.push(v));
    const unsubB = subscribeToHeroWordmarkVisibility((v) => seenB.push(v));
    reportHeroWordmarkVisibility(true);
    unsubA();
    reportHeroWordmarkVisibility(false);
    unsubB();
    assert.deepEqual(seenA, [false, true]);
    assert.deepEqual(seenB, [false, true, false]);
  });
});
