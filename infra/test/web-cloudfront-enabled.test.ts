import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  WEB_CLOUDFRONT_ENABLED,
} from "../lib/environments";

describe("WEB_CLOUDFRONT_ENABLED", () => {
  it("covers every Chatticus cloud environment", () => {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      assert.equal(typeof WEB_CLOUDFRONT_ENABLED[environment], "boolean");
    }
  });

  it("keeps all environments reachable via CloudFront", () => {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      assert.equal(WEB_CLOUDFRONT_ENABLED[environment], true);
    }
  });
});
