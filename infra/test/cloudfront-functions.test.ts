import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SPA_VIEWER_REQUEST_FUNCTION,
  SPA_VIEWER_RESPONSE_FUNCTION,
} from "../lib/cloudfront-functions";

describe("SPA viewer-request rewrite", () => {
  it("rewrites slashless /auth/callback to the Next export index", () => {
    assert.match(SPA_VIEWER_REQUEST_FUNCTION, /uri === "\/auth\/callback"/);
    assert.match(
      SPA_VIEWER_REQUEST_FUNCTION,
      /request\.uri = "\/auth\/callback\/index\.html"/,
    );
  });

  it("does not rewrite /api paths", () => {
    assert.match(SPA_VIEWER_REQUEST_FUNCTION, /uri\.indexOf\("\/api"\) === 0/);
  });
});

describe("SPA viewer-response fallback", () => {
  it("still rewrites 403/404 to 200 for static assets", () => {
    assert.match(SPA_VIEWER_RESPONSE_FUNCTION, /response\.statusCode === 403/);
    assert.match(SPA_VIEWER_RESPONSE_FUNCTION, /response\.statusCode === 404/);
  });
});
