import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rememberedModelId } from "./composer-model";

describe("composer model memory", () => {
  it("prefers a remembered id that is still available", () => {
    const remembered = rememberedModelId(
      ["openai/gpt-5.6-luna", "bedrock/anthropic.claude-sonnet-4-5"],
      "openai/gpt-5.6-luna",
    );
    assert.equal(remembered === "openai/gpt-5.6-luna" || remembered === "bedrock/anthropic.claude-sonnet-4-5", true);
    assert.ok(["openai/gpt-5.6-luna", "bedrock/anthropic.claude-sonnet-4-5"].includes(remembered));
  });

  it("falls back to the deployment default", () => {
    assert.equal(
      rememberedModelId(["openai/gpt-5.6-luna"], "openai/gpt-5.6-luna"),
      "openai/gpt-5.6-luna",
    );
  });
});
