import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { normalizeSpokenText, voiceKeyterms } from "./voice-control";
import { MOONSHINE_VERSION, moonshineBaseUrl } from "./voice-session";
import type { Bot } from "./api";

describe("normalizeSpokenText", () => {
  it("lowercases, drops punctuation and collapses spaces", () => {
    assert.equal(normalizeSpokenText("  Stop   listening, please! "), "stop listening please");
  });

  it("keeps apostrophes, including curly ones", () => {
    assert.equal(normalizeSpokenText("What’s running?"), "what's running");
  });
});

describe("voiceKeyterms", () => {
  it("lists each teammate name once", () => {
    const bot = (name: string): Bot => ({
      bot_id: name,
      tenant_id: "tenant",
      user_id: "user",
      name,
      memory: {},
    });
    assert.deepEqual(voiceKeyterms([bot("Ada"), bot(" Ada "), bot("Grace")]), ["Ada", "Grace"]);
  });
});

describe("Moonshine vendoring", () => {
  it("loads the exact Moonshine version the web package depends on", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(packageJson.dependencies["@moonshine-ai/moonshine-wasm"], MOONSHINE_VERSION);
    assert.equal(moonshineBaseUrl(), `/vendor/moonshine/${MOONSHINE_VERSION}/`);
  });
});
