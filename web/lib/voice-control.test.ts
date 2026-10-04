import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as voiceControl from "./voice-control";
import { normalizeSpokenText, soundex, voiceKeyterms } from "./voice-control";
import { MOONSHINE_VERSION, moonshineBaseUrl } from "./voice-session";
import type { Bot } from "./api";

describe("soundex", () => {
  it("keys names that sound alike the same way", () => {
    assert.equal(soundex("Grace"), soundex("grays"));
    assert.equal(soundex("Robert"), "R163");
    assert.equal(soundex("Ashcraft"), "A261");
  });

  it("keys different names differently", () => {
    assert.notEqual(soundex("Ada"), soundex("Grace"));
  });

  it("returns an empty key for a word with no letters", () => {
    assert.equal(soundex("42"), "");
  });
});

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

describe("editDistance", () => {
  it("counts single-letter edits", () => {
    const { editDistance } = voiceControl;
    assert.equal(editDistance("grace", "grays"), 2);
    assert.equal(editDistance("grace", "gross"), 3);
    assert.equal(editDistance("ada", "ada"), 0);
    assert.equal(editDistance("", "ada"), 3);
  });
});
